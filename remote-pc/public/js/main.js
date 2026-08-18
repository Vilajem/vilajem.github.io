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

function renderClaudeOutput() {
  const pre = document.querySelector('[data-role="claude-output"]');
  if (!pre) return;
  pre.textContent = state.claude.lines.length ? state.claude.lines.join("\n") : "(még nincs kimenet)";
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

async function handleWake() {
  setStageStatus("wake", "in-progress", "Ébresztés folyamatban…");
  renderStage("wake");
  const res = await api.wake();
  if (res.ok) {
    setStageStatus(
      "wake",
      "in-progress",
      `Csomag elküldve (${fmtTime(res.sentAt)}). Várj kb. 30-60 mp-et, majd ellenőrizd az online állapotot.`
    );
  } else {
    setStageStatus("wake", "error", res.message || res.error || "Ismeretlen hiba");
  }
  renderStage("wake");
}

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

async function handleClaudeStart() {
  const folder = state.projects.selected;
  if (!folder) {
    setStageStatus("remote-control", "error", "Előbb válassz mappát a fenti listából.");
    renderStage("remote-control");
    return;
  }
  setStageStatus("remote-control", "in-progress", `Claude indítása: ${folder}…`);
  renderStage("remote-control");
  const res = await api.claudeStart(folder);
  if (res.ok) {
    setStageStatus(
      "remote-control",
      "in-progress",
      res.alreadyRunning ? `Claude már fut ebben a mappában (${folder}).` : `Claude elindítva (${folder}).`
    );
    await handleClaudeOutput();
    await refreshClaudeHint();
  } else {
    setStageStatus("remote-control", "error", res.message || res.error);
  }
  renderStage("remote-control");
  updateProgressBar();
}

async function handleClaudeRemoteControl() {
  setStageStatus("remote-control", "in-progress", "Remote Control aktiválása…");
  renderStage("remote-control");
  const res = await api.claudeRemoteControl();
  if (res.ok) {
    state.claude.lines = res.recentOutput || [];
    save();
    renderClaudeOutput();
    setStageStatus("remote-control", "done", "Remote Control parancs elküldve. Nyisd meg a claude.ai/code appot a csatlakozáshoz.");
  } else if (res.error === "not_running") {
    setStageStatus("remote-control", "needs-attention", "Nincs futó Claude — előbb indítsd el a fenti gombbal.");
  } else {
    setStageStatus("remote-control", "error", res.message || res.error);
  }
  renderStage("remote-control");
  updateProgressBar();
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
  wake: handleWake,
  "check-status": handleCheckStatus,
  "vscode-start": handleVscodeStart,
  "create-project": handleCreateProject,
  "open-project": handleOpenProject,
  "trust-folder": handleTrustFolder,
  "claude-start": handleClaudeStart,
  "claude-remote-control": handleClaudeRemoteControl,
  "claude-output": handleClaudeOutput,
  shutdown: handleShutdown,
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
  document.getElementById("settings-dialog").showModal();
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
}

document.addEventListener("DOMContentLoaded", boot);
