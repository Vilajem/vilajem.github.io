// Small localStorage-backed state store for the control panel.
// No framework, no build step — plain ES module, imported with live bindings.

const STORAGE_KEY = "remote-pc-state-v1";

export const STAGE_IDS = [
  "wake",
  "create-project",
  "open-project",
  "shutdown",
];

function defaultState() {
  const stages = {};
  for (const id of STAGE_IDS) {
    stages[id] = { status: "idle", message: "", at: null };
  }
  return {
    version: 1,
    stages,
    projects: { list: [], selected: "" },
    settings: {
      phoneToken: "",
      remoteDesktopTemplate: "",
      pollIntervalSec: 5,
      autoPoll: false,
      apiBaseUrl: "",
    },
    log: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return defaultState();
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      stages: { ...base.stages, ...(parsed.stages || {}) },
      projects: { ...base.projects, ...(parsed.projects || {}) },
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
  } catch {
    return defaultState();
  }
}

export const state = load();

export function save() {
  const toPersist = { ...state, log: state.log.slice(0, 50) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
}

export function setStageStatus(id, status, message = "") {
  state.stages[id] = {
    ...state.stages[id],
    status,
    message,
    at: new Date().toISOString(),
  };
  save();
}

export function pushLog(entry) {
  state.log.unshift({ ts: new Date().toISOString(), ...entry });
  state.log = state.log.slice(0, 50);
  save();
}

export function resetStage(id) {
  state.stages[id] = { status: "idle", message: "", at: null };
  save();
}

export function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
  const fresh = defaultState();
  Object.assign(state, fresh);
  save();
}
