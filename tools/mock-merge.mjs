// Pure merge logic for the mock Usage Hub. Mirrors docs/04-device-sync.md "Merge rules".
export const FRESH_MS = 10 * 60 * 1000;
export const MAX_BODY = 64 * 1024;
export const WINDOWS = ["today", "last5h", "last7d"];
const LIM = { deviceId: 128, deviceName: 100, model: 100 };

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
  if (isObj(w.byModel)) {
    for (const [name, m] of Object.entries(w.byModel)) {
      if (!isObj(m)) continue;
      const key = trunc(name, LIM.model);
      const c = out.byModel[key] ?? (out.byModel[key] = { messages: 0, tokens: 0 });
      c.messages += num(m.messages);
      c.tokens += num(m.tokens);
    }
  }
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

/** Mutates and returns state. A report older (by sentAt) than the stored one for that device is ignored. */
export function applyReport(state, report, now = Date.now()) {
  const id = trunc(report.deviceId, LIM.deviceId);
  const sentAt = num(report.sentAt);
  const prev = state.devices.get(id);
  if (!prev || sentAt >= prev.sentAt) {
    state.devices.set(id, {
      deviceId: id,
      deviceName: trunc(report.deviceName, LIM.deviceName),
      source: trunc(report.source, 16),
      estimated: report.estimated === true,
      receivedAt: now,
      sentAt,
      windows: Object.fromEntries(WINDOWS.map((k) => [k, normWindow(report.windows?.[k])])),
    });
  }
  // Newest account snapshot wins across all devices (account-wide: shown once, never summed).
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
