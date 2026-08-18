#!/usr/bin/env python3
"""Windows-side agent.

Started at logon via Task Scheduler (see register-task.ps1). Reachable only
from the Tailscale network (restrict with Windows Firewall to
100.64.0.0/10, or simply trust that only the Pi gateway calls it). Lists /
creates project folders, launches VS Code with workspace trust
pre-disabled, spawns and drives a `claude` CLI session, and can shut the
machine down. Stdlib only, no third-party dependencies.
"""

from __future__ import annotations

import collections
import json
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
RUNTIME_CONFIG_PATH = BASE_DIR / "runtime-config.json"
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
OUTPUT_MAXLEN = 200


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH}. Copy config.example.json to config.json and fill it in.")
    with CONFIG_PATH.open() as f:
        return json.load(f)


def load_runtime_overrides() -> dict:
    if not RUNTIME_CONFIG_PATH.exists():
        return {}
    try:
        with RUNTIME_CONFIG_PATH.open() as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_runtime_overrides() -> None:
    with RUNTIME_CONFIG_PATH.open("w") as f:
        json.dump({"projects_root": str(RUNTIME["projects_root"])}, f, indent=2)


CONFIG = load_config()
_overrides = load_runtime_overrides()
# projects_root can be changed at runtime from the phone (Settings), which
# overrides config.json's value and persists to runtime-config.json so it
# survives an agent restart. config.json's value is only the initial default.
RUNTIME = {
    "projects_root": Path(_overrides.get("projects_root", CONFIG["projects_root"])).resolve(),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# -- project folder helpers ---------------------------------------------

def list_projects() -> list[str]:
    RUNTIME["projects_root"].mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in RUNTIME["projects_root"].iterdir() if p.is_dir())


def resolve_project(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError("invalid_name")
    root = RUNTIME["projects_root"]
    target = (root / name).resolve()
    if target != root and root not in target.parents:
        raise ValueError("invalid_name")
    return target


def set_projects_root(raw_path: str) -> Path:
    if not raw_path or not raw_path.strip():
        raise ValueError("invalid_path")
    candidate = Path(raw_path.strip()).resolve()
    candidate.mkdir(parents=True, exist_ok=True)  # raises OSError if not creatable/writable
    RUNTIME["projects_root"] = candidate
    save_runtime_overrides()
    return candidate


# -- claude subprocess tracking (single session at a time) ---------------

claude_lock = threading.Lock()
claude_state = {"proc": None, "folder": None, "output": collections.deque(maxlen=OUTPUT_MAXLEN)}

CLAUDE_JSON_PATH = Path.home() / ".claude.json"


def _ensure_workspace_trusted(target: Path) -> None:
    """Pre-accept the claude CLI's workspace trust dialog for this folder.

    `claude remote-control` refuses to start in an untrusted directory and
    the trust dialog only works in a real interactive terminal, which this
    agent doesn't have — so mirror what accepting it does by hand: set
    hasTrustDialogAccepted for this folder in ~/.claude.json. Uses forward
    slashes as the project key, matching what the CLI itself writes.
    """
    key = target.resolve().as_posix()
    try:
        with CLAUDE_JSON_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    projects = data.setdefault("projects", {})
    entry = projects.setdefault(key, {})
    if entry.get("hasTrustDialogAccepted"):
        return
    entry["hasTrustDialogAccepted"] = True
    with CLAUDE_JSON_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _reader_loop(proc: subprocess.Popen, output: collections.deque) -> None:
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            with claude_lock:
                output.append(line.rstrip("\n"))
    except Exception as e:  # process pipe torn down, etc.
        with claude_lock:
            output.append(f"[agent] reader stopped: {e}")


def start_remote_control(folder_name: str) -> dict:
    target = resolve_project(folder_name)
    if not target.is_dir():
        raise FileNotFoundError(folder_name)
    with claude_lock:
        proc = claude_state["proc"]
        if proc is not None and proc.poll() is None and claude_state["folder"] == folder_name:
            return {"alreadyRunning": True}
        _ensure_workspace_trusted(target)
        claude_cmd = CONFIG.get("claude_command", "claude")
        new_proc = subprocess.Popen(
            [claude_cmd, "remote-control", "--name", folder_name],
            cwd=str(target),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        output = collections.deque(maxlen=OUTPUT_MAXLEN)
        claude_state["proc"] = new_proc
        claude_state["folder"] = folder_name
        claude_state["output"] = output
        threading.Thread(target=_reader_loop, args=(new_proc, output), daemon=True).start()
    return {"alreadyRunning": False}


def get_claude_output() -> tuple[bool, list[str]]:
    with claude_lock:
        proc = claude_state["proc"]
        running = proc is not None and proc.poll() is None
        lines = list(claude_state["output"])[-50:]
    return running, lines


# -- claude login heuristic ----------------------------------------------

def claude_status() -> dict:
    cred_path = Path.home() / ".claude" / ".credentials.json"
    exists = cred_path.is_file()
    if not exists:
        return {"credentialsFileExists": False, "lastModifiedAt": None, "hint": "likely_not_logged_in"}
    mtime = cred_path.stat().st_mtime
    last_modified = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    return {"credentialsFileExists": True, "lastModifiedAt": last_modified, "hint": "likely_logged_in"}


# -- shutdown --------------------------------------------------------------

def do_shutdown(delay_sec: int) -> None:
    if CONFIG.get("dry_run"):
        print(f"[dry-run] would run: shutdown /s /t {delay_sec}")
        return
    subprocess.Popen(["shutdown", "/s", "/t", str(delay_sec)])


class Handler(BaseHTTPRequestHandler):
    server_version = "RemotePCAgent/1.0"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_token(self) -> bool:
        return self.headers.get("X-Auth-Token", "") == CONFIG["auth_token"]

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    # -- routing -----------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(200, {"ok": True})
            return
        if not self._check_token():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        if path == "/api/projects":
            self._send_json(200, {"ok": True, "projects": list_projects()})
        elif path == "/api/claude/output":
            running, lines = get_claude_output()
            self._send_json(200, {"ok": True, "running": running, "lines": lines})
        elif path == "/api/claude-status":
            self._send_json(200, {"ok": True, **claude_status()})
        elif path == "/api/config":
            self._send_json(200, {"ok": True, "projectsRoot": str(RUNTIME["projects_root"])})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._check_token():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        if path == "/api/projects":
            self._create_project()
        elif path == "/api/vscode/open":
            self._open_vscode()
        elif path == "/api/claude/remote-control":
            self._remote_control()
        elif path == "/api/shutdown":
            self._shutdown()
        elif path == "/api/config":
            self._set_config()
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # -- handlers ------------------------------------------------------
    def _create_project(self):
        body = self._read_json()
        name = body.get("name", "")
        try:
            target = resolve_project(name)
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid_name"})
            return
        if target.exists():
            self._send_json(200, {"ok": True, "name": name, "alreadyExisted": True})
            return
        target.mkdir(parents=True)
        self._send_json(200, {"ok": True, "name": name})

    def _open_vscode(self):
        body = self._read_json()
        folder = body.get("folder")
        code_cmd = CONFIG.get("code_command", "code")
        args = [code_cmd, "--disable-workspace-trust"]
        if folder:
            try:
                target = resolve_project(folder)
            except ValueError:
                self._send_json(400, {"ok": False, "error": "invalid_name"})
                return
            if not target.is_dir():
                self._send_json(404, {"ok": False, "error": "not_found"})
                return
            args.append(str(target))
        try:
            subprocess.Popen(args, shell=False)
        except OSError as e:
            self._send_json(500, {"ok": False, "error": "launch_failed", "message": str(e)})
            return
        self._send_json(200, {"ok": True, "project": folder, "launchedAt": now_iso()})

    def _remote_control(self):
        body = self._read_json()
        folder = body.get("folder", "")
        try:
            result = start_remote_control(folder)
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid_name"})
            return
        except FileNotFoundError:
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        except OSError as e:
            self._send_json(500, {"ok": False, "error": "launch_failed", "message": str(e)})
            return
        self._send_json(200, {"ok": True, "startedAt": now_iso(), **result})

    def _shutdown(self):
        body = self._read_json()
        delay_sec = int(body.get("delaySec", 5))
        try:
            do_shutdown(delay_sec)
        except OSError as e:
            self._send_json(500, {"ok": False, "error": "shutdown_failed", "message": str(e)})
            return
        self._send_json(200, {"ok": True, "shutdownAt": now_iso(), "delaySec": delay_sec})

    def _set_config(self):
        body = self._read_json()
        raw_path = body.get("projectsRoot", "")
        try:
            new_root = set_projects_root(raw_path)
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid_path", "message": "Adj meg egy elérési utat."})
            return
        except OSError as e:
            self._send_json(400, {"ok": False, "error": "invalid_path", "message": str(e)})
            return
        self._send_json(200, {"ok": True, "projectsRoot": str(new_root)})

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass


def main():
    port = CONFIG.get("listen_port", 8788)
    bind = CONFIG.get("bind_address", "0.0.0.0")
    server = ThreadingHTTPServer((bind, port), Handler)
    print(f"remote-pc windows-agent listening on {bind}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
