// Pure merge logic for the mock DeskBuddy server. Mirrors firmware/SPEC.md "Merge rules".
export const MAX_DEVICES = 8;
export const MAX_MODELS = 6;
export const FRESH_MS = 10 * 60 * 1000;
export const MAX_BODY = 4096;
export const WINDOWS = ["today", "last5h", "last7d"];
const LIM = { deviceId: 64, deviceName: 32, model: 40 };

const trunc = (v, n) => String(v ?? "").slice(0, n);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Returns null when the body is not an acceptable report (-> HTTP 400). */
export function validateReport(r) {
  if (!isObj(r) || r.v !== 1) return null;
  if (typeof r.deviceId !== "string" || r.deviceId === "") return null;
  return r;
}

function normWindow(w) {
  const out = { messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} };
  if (!isObj(w)) return out;
  out.messages = num(w.messages);
  out.promptTokens = num(w.promptTokens);
  out.outputTokens = num(w.outputTokens);
  const models = [];
  if (isObj(w.byModel)) {
    for (const [name, m] of Object.entries(w.byModel)) {
      if (!isObj(m)) continue;
      models.push([trunc(name, LIM.model), { messages: num(m.messages), tokens: num(m.tokens) }]);
    }
  }
  models.sort((a, b) => b[1].tokens - a[1].tokens);
  const add = (name, m) => {
    const c = out.byModel[name] ?? (out.byModel[name] = { messages: 0, tokens: 0 });
    c.messages += m.messages;
    c.tokens += m.tokens;
  };
  models.slice(0, MAX_MODELS).forEach(([n, m]) => add(n, m));
  models.slice(MAX_MODELS).forEach(([, m]) => add("other", m));
  return out;
}

function normAccount(a) {
  if (!isObj(a) || typeof a.fetchedAt !== "number" || !Array.isArray(a.windows)) return null;
  return {
    fetchedAt: a.fetchedAt,
    windows: a.windows.filter(isObj).map((w) => ({
      name: trunc(w.name, 32),
      utilization: num(w.utilization),
      ...(typeof w.resetsAt === "string" ? { resetsAt: trunc(w.resetsAt, 40) } : {}),
    })),
  };
}

/** state = { devices: Map<deviceId, stored>, account }. */
export function newState() {
  return { devices: new Map(), account: null };
}

/** Mutates and returns state. */
export function applyReport(state, report, now = Date.now()) {
  const id = trunc(report.deviceId, LIM.deviceId);
  const stored = {
    deviceId: id,
    deviceName: trunc(report.deviceName, LIM.deviceName),
    source: trunc(report.source, 16),
    estimated: report.estimated === true,
    receivedAt: now,
    sentAt: num(report.sentAt),
    windows: Object.fromEntries(WINDOWS.map((k) => [k, normWindow(report.windows?.[k])])),
  };
  if (!state.devices.has(id) && state.devices.size >= MAX_DEVICES) {
    let oldest = null;
    for (const d of state.devices.values()) if (!oldest || d.receivedAt < oldest.receivedAt) oldest = d;
    state.devices.delete(oldest.deviceId);
  }
  state.devices.set(id, stored);
  const acc = normAccount(report.account);
  if (acc && (!state.account || acc.fetchedAt > state.account.fetchedAt)) state.account = acc;
  return state;
}

export function isFresh(d, now = Date.now()) {
  return now - d.receivedAt < FRESH_MS;
}

/** Merged view: device list (with fresh flag) + totals over fresh devices only. */
export function mergedView(state, now = Date.now()) {
  const devices = [...state.devices.values()].map((d) => ({ ...d, fresh: isFresh(d, now) }));
  const totals = Object.fromEntries(WINDOWS.map((k) => [k, { messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} }]));
  for (const d of devices) {
    if (!d.fresh) continue;
    for (const k of WINDOWS) {
      const t = totals[k];
      const w = d.windows[k];
      t.messages += w.messages;
      t.promptTokens += w.promptTokens;
      t.outputTokens += w.outputTokens;
      for (const [m, v] of Object.entries(w.byModel)) {
        const c = t.byModel[m] ?? (t.byModel[m] = { messages: 0, tokens: 0 });
        c.messages += v.messages;
        c.tokens += v.tokens;
      }
    }
  }
  return { devices, totals, account: state.account };
}
