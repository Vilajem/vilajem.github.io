import { state, pushLog } from "./state.js";

const TIMEOUT_MS = 8000;

// When no explicit API base URL is set, resolve API paths relative to
// wherever this page itself was loaded from (e.g. served under an nginx
// prefix like /remote-pc/) instead of the domain root.
function defaultBase() {
  return new URL(".", window.location.href).href.replace(/\/$/, "");
}

async function apiCall(method, path, body) {
  const base = state.settings.apiBaseUrl || defaultBase();
  const url = base + path;
  const headers = { "X-Auth-Token": state.settings.phoneToken };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  let status = 0;
  let payload = {};
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    status = res.status;
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    payload = { ok: false, error: "network_error", message: err.message };
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - t0);
  pushLog({
    method,
    path,
    ok: !!payload.ok,
    status,
    ms,
    message: payload.message || payload.error || "",
  });
  return payload;
}

export const api = {
  status: () => apiCall("GET", "/api/status"),
  listProjects: () => apiCall("GET", "/api/projects"),
  createProject: (name) => apiCall("POST", "/api/projects", { name }),
  vscodeOpen: (folder) => apiCall("POST", "/api/vscode/open", folder ? { folder } : {}),
  shutdown: (delaySec) => apiCall("POST", "/api/shutdown", { delaySec }),
  getConfig: () => apiCall("GET", "/api/config"),
  setConfig: (projectsRoot) => apiCall("POST", "/api/config", { projectsRoot }),
};
