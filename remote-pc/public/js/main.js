import { state, save, setStageStatus, pushLog, clearAll, STAGE_IDS } from "./state.js";
import { api } from "./api.js";

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

// -- render ---------------------------------------------------------------

const STATUS_LABELS = {
  idle: "IDLE",
  "in-progress": "RUNNING",
  done: "DONE",
  error: "ERROR",
  "needs-attention": "ATTN",
};

function renderStage(id) {
  const card = document.querySelector(`.stage-card[data-stage="${id}"]`);
  if (!card) return;
  const s = state.stages[id];
  card.dataset.status = s.status;
  const badge = card.querySelector('[data-role="badge"]');
  if (badge) badge.textContent = STATUS_LABELS[s.status] || s.status.toUpperCase();
  const feedback = card.querySelector('[data-role="feedback"]');
  if (feedback) feedback.textContent = s.message || "Még nem történt semmi.";
  const spinner = card.querySelector('[data-role="spinner"]');
  if (spinner) spinner.classList.toggle("is-active", s.status === "in-progress");
}

// -- "thinking" indicator: an animated point-and-line network (Watch Dogs-ish) --

const SVG_NS = "http://www.w3.org/2000/svg";
const GEO_POINTS = [
  { r: 9, speed: 1.3, phase: 0.0 },
  { r: 7, speed: -1.7, phase: 2.1 },
  { r: 10, speed: 2.0, phase: 4.2 },
  { r: 6.5, speed: -1.1, phase: 1.0 },
];
const GEO_PAIRS = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];
let geoTime = 0;

function buildGeoSpinner() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.classList.add("geo-spinner-svg");
  for (const [a, b] of GEO_PAIRS) {
    const line = document.createElementNS(SVG_NS, "line");
    line.dataset.a = a;
    line.dataset.b = b;
    line.setAttribute("class", "geo-line");
    svg.appendChild(line);
  }
  GEO_POINTS.forEach((_, i) => {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("r", "1.6");
    dot.setAttribute("class", "geo-dot");
    dot.dataset.i = i;
    svg.appendChild(dot);
  });
  return svg;
}

function initGeoSpinners() {
  document.querySelectorAll(".thinking-spinner").forEach((container) => {
    container.appendChild(buildGeoSpinner());
  });
}

function tickGeoSpinners() {
  geoTime += 0.025;
  const positions = GEO_POINTS.map((p) => ({
    x: 16 + p.r * Math.cos(geoTime * p.speed + p.phase),
    y: 16 + p.r * Math.sin(geoTime * p.speed * 1.15 + p.phase),
  }));
  document.querySelectorAll(".geo-spinner-svg").forEach((svg) => {
    svg.querySelectorAll(".geo-dot").forEach((dot) => {
      const p = positions[Number(dot.dataset.i)];
      dot.setAttribute("cx", p.x.toFixed(2));
      dot.setAttribute("cy", p.y.toFixed(2));
    });
    svg.querySelectorAll(".geo-line").forEach((line) => {
      const a = positions[Number(line.dataset.a)];
      const b = positions[Number(line.dataset.b)];
      line.setAttribute("x1", a.x.toFixed(2));
      line.setAttribute("y1", a.y.toFixed(2));
      line.setAttribute("x2", b.x.toFixed(2));
      line.setAttribute("y2", b.y.toFixed(2));
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const opacity = Math.max(0.12, Math.min(0.9, 1 - dist / 22));
      line.setAttribute("opacity", opacity.toFixed(2));
    });
  });
  requestAnimationFrame(tickGeoSpinners);
}

function updateProgressBar() {
  const done = STAGE_IDS.filter((id) => state.stages[id].status === "done").length;
  const fill = document.getElementById("progress-fill");
  fill.style.width = `${Math.round((done / STAGE_IDS.length) * 100)}%`;
  fill.parentElement.setAttribute("aria-valuenow", String(done));
}

function renderProjectSelect() {
  const select = document.getElementById("project-select");
  const current = state.projects.selected;
  select.innerHTML = '<option value="">— válassz mappát —</option>';
  for (const name of state.projects.list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    select.appendChild(opt);
  }
}

let lastRenderedOutput = null;
let typingTimer = null;

function renderClaudeOutput() {
  const pre = document.querySelector('[data-role="claude-output"]');
  if (!pre) return;
  const text = state.claude.lines.length ? state.claude.lines.join("\n") : "(még nincs kimenet)";
  if (text === lastRenderedOutput) return;
  lastRenderedOutput = text;
  typeIntoElement(pre, text);
}

function typeIntoElement(el, text) {
  if (typingTimer) clearInterval(typingTimer);
  el.textContent = "";
  let i = 0;
  const CHARS_PER_TICK = 3;
  typingTimer = setInterval(() => {
    i += CHARS_PER_TICK;
    el.textContent = text.slice(0, i);
    el.scrollTop = el.scrollHeight;
    if (i >= text.length) {
      el.textContent = text;
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }, 12);
}

function renderClaudeHint(text) {
  const el = document.querySelector('.stage-card[data-stage="remote-control"] [data-role="claude-hint"]');
  if (el) el.textContent = text || "";
}

function renderLog() {
  const list = document.getElementById("log-list");
  list.innerHTML = "";
  for (const entry of state.log.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = new Date(entry.ts).toLocaleTimeString();
    row.innerHTML = `<span class="muted">${time}</span><span class="${entry.ok ? "ok" : "fail"}">${entry.method} ${entry.path}</span><span class="muted">${entry.status || 0} ${entry.ms}ms</span><span>${entry.message || ""}</span>`;
    list.appendChild(row);
  }
}

function renderAll() {
  for (const id of STAGE_IDS) renderStage(id);
  updateProgressBar();
  renderProjectSelect();
  renderClaudeOutput();
  renderLog();
}

// -- actions ---------------------------------------------------------------

async function handleCheckStatus() {
  const res = await api.status();
  if (!res.ok) {
    setStageStatus("wake", "error", res.message || "Nem sikerült lekérdezni az állapotot.");
  } else if (res.online) {
    setStageStatus("wake", "done", `Online — ${res.latencyMs} ms (${fmtTime(res.checkedAt)})`);
  } else {
    setStageStatus("wake", "needs-attention", `Offline (${res.reason || "ismeretlen ok"}) — ${fmtTime(res.checkedAt)}`);
  }
  renderStage("wake");
  updateProgressBar();
}

async function handleVscodeStart() {
  setStageStatus("vscode-start", "in-progress", "Indítás…");
  renderStage("vscode-start");
  const res = await api.vscodeOpen(null);
  if (res.ok) setStageStatus("vscode-start", "done", `Elindítva (${fmtTime(res.launchedAt)}).`);
  else setStageStatus("vscode-start", "error", res.message || res.error);
  renderStage("vscode-start");
  updateProgressBar();
}

async function handleRefreshProjects() {
  const res = await api.listProjects();
  if (res.ok) {
    state.projects.list = res.projects || [];
    save();
    renderProjectSelect();
  }
  return res;
}

function selectProject(name) {
  state.projects.selected = name;
  save();
  renderProjectSelect();
}

async function handleCreateProject() {
  const input = document.getElementById("new-project-name");
  const name = input.value.trim();
  if (!name) {
    setStageStatus("create-project", "error", "Adj meg egy mappanevet (betű/szám/kötőjel/aláhúzás).");
    renderStage("create-project");
    return;
  }
  setStageStatus("create-project", "in-progress", "Létrehozás…");
  renderStage("create-project");
  const res = await api.createProject(name);
  if (res.ok) {
    setStageStatus("create-project", "done", res.alreadyExisted ? `"${name}" már létezett.` : `"${name}" létrehozva.`);
    input.value = "";
    await handleRefreshProjects();
    selectProject(name);
  } else {
    setStageStatus("create-project", "error", res.message || res.error);
  }
  renderStage("create-project");
  updateProgressBar();
}

async function handleOpenProject() {
  const folder = state.projects.selected;
  if (!folder) {
    setStageStatus("open-project", "error", "Előbb válassz mappát a fenti listából.");
    renderStage("open-project");
    return;
  }
  setStageStatus("open-project", "in-progress", `Megnyitás: ${folder}…`);
  renderStage("open-project");
  const res = await api.vscodeOpen(folder);
  if (res.ok) setStageStatus("open-project", "done", `Megnyitva: ${folder} (${fmtTime(res.launchedAt)})`);
  else setStageStatus("open-project", "error", res.message || res.error);
  renderStage("open-project");
  updateProgressBar();
}

async function handleTrustFolder() {
  const folder = state.projects.selected;
  if (!folder) {
    setStageStatus("trust-folder", "error", "Előbb válassz mappát a fenti listából.");
    renderStage("trust-folder");
    return;
  }
  setStageStatus("trust-folder", "in-progress", `Megbízhatóvá tétel: ${folder}…`);
  renderStage("trust-folder");
  const res = await api.vscodeOpen(folder);
  if (res.ok) setStageStatus("trust-folder", "done", `Megbízható: ${folder} (${fmtTime(res.launchedAt)})`);
  else setStageStatus("trust-folder", "error", res.message || res.error);
  renderStage("trust-folder");
  updateProgressBar();
}

async function handleClaudeOutput() {
  const res = await api.claudeOutput();
  if (res.ok) {
    state.claude.running = res.running;
    state.claude.lines = res.lines || [];
    save();
    renderClaudeOutput();
  }
}

async function refreshClaudeHint() {
  const res = await api.claudeStatus();
  if (!res.ok) return;
  if (res.hint === "likely_logged_in") {
    renderClaudeHint(`Valószínűleg be vagy jelentkezve (hitelesítés: ${fmtTime(res.lastModifiedAt)}).`);
  } else {
    renderClaudeHint("Nincs mentett Claude hitelesítés — ha a kimenet bejelentkezést kér, egyszeri manuális belépés szükséges.");
  }
}

async function handleClaudeRemoteControl() {
  const folder = state.projects.selected;
  if (!folder) {
    setStageStatus("remote-control", "error", "Előbb válassz mappát a fenti listából.");
    renderStage("remote-control");
    return;
  }
  setStageStatus("remote-control", "in-progress", `Remote Control indítása: ${folder}…`);
  renderStage("remote-control");
  const res = await api.claudeRemoteControl(folder);
  if (res.ok) {
    setStageStatus(
      "remote-control",
      "done",
      res.alreadyRunning
        ? `Már fut ebben a mappában (${folder}).`
        : `Elindítva (${folder}). Nyisd meg a claude.ai/code appot a csatlakozáshoz.`
    );
    await handleClaudeOutput();
    await refreshClaudeHint();
  } else {
    setStageStatus("remote-control", "error", res.message || res.error);
  }
  renderStage("remote-control");
  updateProgressBar();
}

function setConfigStatus(text, isError = false) {
  const el = document.getElementById("config-status");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "var(--error)" : "var(--text-muted)";
}

async function handleConfigRefresh() {
  setConfigStatus("Lekérdezés…");
  const res = await api.getConfig();
  if (res.ok) {
    document.getElementById("setting-projects-root").value = res.projectsRoot;
    setConfigStatus(`Jelenlegi: ${res.projectsRoot}`);
  } else {
    setConfigStatus(res.message || res.error || "Nem sikerült lekérdezni.", true);
  }
}

async function handleConfigSave() {
  const value = document.getElementById("setting-projects-root").value.trim();
  if (!value) {
    setConfigStatus("Adj meg egy elérési utat.", true);
    return;
  }
  setConfigStatus("Mentés…");
  const res = await api.setConfig(value);
  if (res.ok) {
    setConfigStatus(`Elmentve: ${res.projectsRoot}`);
    handleRefreshProjects();
  } else {
    setConfigStatus(res.message || res.error || "Nem sikerült elmenteni.", true);
  }
}

async function handleShutdown() {
  if (!window.confirm("Biztosan leállítod a Windows gépet?")) return;
  setStageStatus("shutdown", "in-progress", "Leállítás kezdeményezve…");
  renderStage("shutdown");
  const res = await api.shutdown(5);
  if (res.ok) setStageStatus("shutdown", "done", `Leállítás elindítva ${res.delaySec}s múlva (${fmtTime(res.shutdownAt)}).`);
  else setStageStatus("shutdown", "error", res.message || res.error);
  renderStage("shutdown");
  updateProgressBar();
}

const ACTIONS = {
  "check-status": handleCheckStatus,
  "vscode-start": handleVscodeStart,
  "create-project": handleCreateProject,
  "open-project": handleOpenProject,
  "trust-folder": handleTrustFolder,
  "claude-remote-control": handleClaudeRemoteControl,
  "claude-output": handleClaudeOutput,
  "refresh-projects": handleRefreshProjects,
  shutdown: handleShutdown,
  "config-refresh": handleConfigRefresh,
  "config-save": handleConfigSave,
};

// -- settings dialog ---------------------------------------------------------------

let pollTimer = null;

function restartAutoPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (!state.settings.autoPoll) return;
  const seconds = Math.max(2, state.settings.pollIntervalSec || 5);
  pollTimer = setInterval(() => {
    handleCheckStatus();
    if (state.claude.running) handleClaudeOutput();
  }, seconds * 1000);
}

function openSettingsDialog() {
  document.getElementById("setting-phone-token").value = state.settings.phoneToken;
  document.getElementById("setting-poll-interval").value = state.settings.pollIntervalSec;
  document.getElementById("setting-auto-poll").checked = state.settings.autoPoll;
  document.getElementById("setting-api-base-url").value = state.settings.apiBaseUrl;
  document.getElementById("setting-rdp-template").value = state.settings.remoteDesktopTemplate;
  setConfigStatus("");
  document.getElementById("settings-dialog").showModal();
  handleConfigRefresh();
}

function saveSettingsFromForm() {
  state.settings.phoneToken = document.getElementById("setting-phone-token").value.trim();
  state.settings.pollIntervalSec = Math.max(2, Number(document.getElementById("setting-poll-interval").value) || 5);
  state.settings.autoPoll = document.getElementById("setting-auto-poll").checked;
  state.settings.apiBaseUrl = document.getElementById("setting-api-base-url").value.trim();
  state.settings.remoteDesktopTemplate = document.getElementById("setting-rdp-template").value.trim();
  save();
  restartAutoPoll();
}

// -- boot ---------------------------------------------------------------

function wireEvents() {
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    btn.classList.remove("flash");
    // eslint-disable-next-line no-unused-expressions
    btn.offsetWidth; // restart the animation even on rapid repeat clicks
    btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), 400);
    const action = ACTIONS[btn.dataset.action];
    if (action) action();
  });

  document.getElementById("project-select").addEventListener("change", (ev) => {
    selectProject(ev.target.value);
  });

  document.getElementById("settings-btn").addEventListener("click", openSettingsDialog);

  document.getElementById("settings-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    saveSettingsFromForm();
    document.getElementById("settings-dialog").close();
  });

  document.getElementById("settings-clear").addEventListener("click", () => {
    if (!window.confirm("Törlöd az összes helyi beállítást és állapotot?")) return;
    clearAll();
    document.getElementById("settings-dialog").close();
    renderAll();
    restartAutoPoll();
  });

  document.getElementById("open-rdp-link").addEventListener("click", () => {
    const template = document.getElementById("setting-rdp-template").value.trim();
    if (template) window.location.href = template;
  });

  document.getElementById("clear-log").addEventListener("click", () => {
    state.log = [];
    save();
    renderLog();
  });
}

function boot() {
  wireEvents();
  renderAll();
  if (state.projects.list.length === 0) handleRefreshProjects();
  restartAutoPoll();
  refreshClaudeHint();
  initGeoSpinners();
  requestAnimationFrame(tickGeoSpinners);
}

document.addEventListener("DOMContentLoaded", boot);
