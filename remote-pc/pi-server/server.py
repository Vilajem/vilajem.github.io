#!/usr/bin/env python3
"""Always-on Raspberry Pi gateway.

Serves the iPhone control webpage (remote-pc/public/) and proxies
project / VS Code / Claude Code commands to the Windows agent over the
Tailscale network. Stdlib only.
"""

from __future__ import annotations

import json
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
PUBLIC_DIR = (BASE_DIR.parent / "public").resolve()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

# Paths that get forwarded verbatim to the Windows agent.
PROXY_PATHS = {
    "/api/projects",
    "/api/vscode/open",
    "/api/claude/remote-control",
    "/api/claude/output",
    "/api/shutdown",
    "/api/claude-status",
    "/api/config",
}


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH}. Copy config.example.json to config.json and fill it in.")
    with CONFIG_PATH.open() as f:
        return json.load(f)


CONFIG = load_config()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_request(method: str, path: str, body: dict | None = None, timeout: float = 5.0):
    """Returns (status, payload). status == 0 means the agent was unreachable."""
    url = f"http://{CONFIG['windows_agent_host']}:{CONFIG['windows_agent_port']}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Auth-Token", CONFIG["windows_agent_token"])
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"message": raw.decode(errors="replace")}
        return e.code, payload
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        return 0, {"message": str(e)}


class Handler(BaseHTTPRequestHandler):
    server_version = "RemotePCGateway/1.0"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_token(self) -> bool:
        token = self.headers.get("X-Auth-Token", "")
        return token == CONFIG["phone_token"]

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    # -- routing -----------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            self._handle_status()
        elif path in PROXY_PATHS:
            self._handle_proxy("GET", path)
        elif path.startswith("/api/"):
            self._send_json(404, {"ok": False, "error": "not_found"})
        else:
            self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path in PROXY_PATHS:
            self._handle_proxy("POST", path)
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # -- handlers ------------------------------------------------------
    def _handle_status(self):
        if not self._check_token():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        t0 = time.monotonic()
        status, _payload = agent_request("GET", "/health", timeout=3.0)
        latency_ms = int((time.monotonic() - t0) * 1000)
        checked_at = now_iso()
        if status == 200:
            self._send_json(200, {"ok": True, "online": True, "checkedAt": checked_at, "latencyMs": latency_ms})
        elif status == 0:
            self._send_json(200, {"ok": True, "online": False, "reason": "agent_unreachable", "checkedAt": checked_at})
        else:
            self._send_json(200, {"ok": True, "online": False, "reason": "agent_error", "checkedAt": checked_at})

    def _handle_proxy(self, method: str, path: str):
        if not self._check_token():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        body = self._read_json_body() if method == "POST" else None
        status, payload = agent_request(method, path, body)
        if status == 0:
            self._send_json(
                502,
                {
                    "ok": False,
                    "error": "agent_unreachable",
                    "message": payload.get("message", "windows agent unreachable"),
                },
            )
            return
        self._send_json(status, payload)

    def _serve_static(self, rel_path: str):
        if rel_path == "/":
            rel_path = "/index.html"
        target = (PUBLIC_DIR / rel_path.lstrip("/")).resolve()
        if PUBLIC_DIR != target and PUBLIC_DIR not in target.parents:
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        if not target.is_file():
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        content_type = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass  # keep the journal quiet; comment this out to debug


def main():
    port = CONFIG.get("listen_port", 8787)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"remote-pc pi-server listening on 127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
