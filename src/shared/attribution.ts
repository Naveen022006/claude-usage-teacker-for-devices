// Per-model attribution of plan-limit consumption (pure; no chrome.*, no DOM).
//
// The account usage endpoint only gives a total utilisation per window (5h / weekly). We watch that number
// move after each reply and split every increase between the replies (contributions) that happened since the
// previous reading, weighted by an estimate of their cost. The result is an ESTIMATE in percentage points.
// Invariant: sum(byModel) + other ~= current utilisation for each window.

export const ATTR_WINDOWS = ["five_hour", "seven_day"] as const;
export type AttrWindow = (typeof ATTR_WINDOWS)[number];

export type ContributionSource = "chrome" | "hub";

export interface Contribution {
  model: string;
  weight: number;
  ts: number;
  source: ContributionSource;
}

export interface WindowLedger {
  /** resetsAt (ISO) of the cycle this ledger belongs to. "" when the API gave none. */
  cycle: string;
  lastUtil: number | null;
  /** percentage points of the window attributed to each model (floats) */
  byModel: Record<string, number>;
  /** points not attributable: other devices, mobile, usage before tracking started */
  other: number;
}

export interface Ledger {
  windows: Partial<Record<AttrWindow, WindowLedger>>;
  pending: Contribution[];
  lastReadingAt: number;
  /** last seen last5h tokens per hub device and model, to turn snapshots into deltas */
  hubPrev: Record<string, Record<string, number>>;
}

/** What the widget needs. */
export type AttributionView = Partial<Record<AttrWindow, { byModel: Record<string, number>; other: number }>>;

export const CYCLE_TOLERANCE_MS = 120_000;
export const PENDING_MAX_AGE_MS = 30 * 60_000;
const MAX_PENDING = 200;
const MAX_HUB_DEVICES = 50;

export function emptyLedger(): Ledger {
  return { windows: {}, pending: [], lastReadingAt: 0, hubPrev: {} };
}

/** Cost factor relative to Sonnet, by substring of the model id. */
export function modelFactor(model: string): number {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("opus")) return 5;
  if (m.includes("sonnet")) return 1;
  if (m.includes("haiku")) return 0.3;
  if (m.includes("fable")) return 1;
  return 1;
}

/** Relative cost of a reply; only used to split one reading's delta between several replies. */
export function replyWeight(model: string, promptTokens: number, outputTokens: number): number {
  const p = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const o = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (p + 5 * o) * modelFactor(model);
}

export function tokenWeight(model: string, tokens: number): number {
  return (Number.isFinite(tokens) && tokens > 0 ? tokens : 0) * modelFactor(model);
}

export function addContribution(l: Ledger, c: Contribution): Ledger {
  if (!(c.weight >= 0) || !Number.isFinite(c.weight) || !Number.isFinite(c.ts)) return l;
  return { ...l, pending: [...l.pending, { ...c, weight: Math.max(c.weight, 1e-9) }].slice(-MAX_PENDING) };
}

const total = (w: WindowLedger): number => Object.values(w.byModel).reduce((a, b) => a + b, 0) + w.other;

function sameCycle(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= CYCLE_TOLERANCE_MS;
}

/** Adds `delta` points to `w`, split across `pending` by weight (or to `other` when there are none). */
function distribute(w: WindowLedger, delta: number, pending: Contribution[]): void {
  const sum = pending.reduce((a, c) => a + c.weight, 0);
  if (!pending.length || !(sum > 0)) {
    w.other += delta;
    return;
  }
  for (const c of pending) w.byModel[c.model] = (w.byModel[c.model] ?? 0) + (delta * c.weight) / sum;
}

/** Scales everything down proportionally so the total equals `util` (server-side correction). */
function scaleTo(w: WindowLedger, util: number): void {
  const t = total(w);
  if (!(t > 0)) {
    w.other = util;
    return;
  }
  const k = util / t;
  for (const m of Object.keys(w.byModel)) w.byModel[m] *= k;
  w.other *= k;
}

/**
 * Applies one account-usage reading taken at `now`. Returns a new ledger; never mutates the input.
 * Contributions with ts <= now are consumed (after BOTH windows are updated); older than 30 min are dropped.
 */
export function applyReading(
  ledger: Ledger,
  usage: { windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  now: number,
): Ledger {
  if (!usage) return ledger;
  if (now < ledger.lastReadingAt) return ledger; // out-of-order (stale) reading
  const usable = ledger.pending.filter((c) => now - c.ts <= PENDING_MAX_AGE_MS);
  const eligible = usable.filter((c) => c.ts <= now);
  const windows: Ledger["windows"] = { ...ledger.windows };
  let touched = false;
  for (const name of ATTR_WINDOWS) {
    const aw = usage.windows.find((w) => w.name === name);
    if (!aw || !Number.isFinite(aw.utilization)) continue;
    touched = true;
    const util = Math.min(100, Math.max(0, aw.utilization));
    const cycle = aw.resetsAt ?? "";
    const prev = windows[name];
    if (!prev || !sameCycle(prev.cycle, cycle)) {
      const fresh: WindowLedger = { cycle, lastUtil: util, byModel: {}, other: 0 };
      // First sight: whatever is already used happened before tracking. Rollover: the new cycle's first
      // points can only come from replies we just saw.
      if (prev && util > 0) distribute(fresh, util, eligible);
      else fresh.other = util;
      windows[name] = fresh;
      continue;
    }
    const w: WindowLedger = { cycle: prev.cycle, lastUtil: util, byModel: { ...prev.byModel }, other: prev.other };
    const delta = util - (prev.lastUtil ?? util);
    if (delta > 0) distribute(w, delta, eligible);
    else if (delta < 0) scaleTo(w, util);
    windows[name] = w;
  }
  if (!touched) return ledger;
  return {
    ...ledger,
    windows,
    pending: usable.filter((c) => c.ts > now),
    lastReadingAt: now,
  };
}

export interface HubDeviceLite {
  deviceId: string;
  source: string;
  last5hByModel: Record<string, number>; // model -> tokens
}

/**
 * Turns hub snapshots into contributions. The first sight of a device only records a baseline.
 * Only claude-code / desktop devices count (a chrome device's replies are captured locally).
 */
export function recordHubSnapshot(ledger: Ledger, devices: HubDeviceLite[], now: number): { ledger: Ledger; added: number } {
  const hubPrev: Ledger["hubPrev"] = { ...ledger.hubPrev };
  const adds: Contribution[] = [];
  for (const d of devices) {
    if (d.source !== "claude-code" && d.source !== "desktop") continue;
    const cur: Record<string, number> = {};
    for (const [m, t] of Object.entries(d.last5hByModel)) if (Number.isFinite(t) && t >= 0) cur[m] = t;
    const prev = hubPrev[d.deviceId];
    if (prev) {
      for (const [m, t] of Object.entries(cur)) {
        const delta = t - (prev[m] ?? 0);
        if (delta > 0) adds.push({ model: m, weight: tokenWeight(m, delta), ts: now, source: "hub" });
      }
    }
    hubPrev[d.deviceId] = cur;
  }
  const keys = Object.keys(hubPrev);
  if (keys.length > MAX_HUB_DEVICES) for (const k of keys.slice(0, keys.length - MAX_HUB_DEVICES)) delete hubPrev[k];
  let next: Ledger = { ...ledger, hubPrev };
  for (const c of adds) next = addContribution(next, c);
  return { ledger: next, added: adds.length };
}

export function attributionView(l: Ledger): AttributionView {
  const out: AttributionView = {};
  for (const name of ATTR_WINDOWS) {
    const w = l.windows[name];
    if (w) out[name] = { byModel: { ...w.byModel }, other: w.other };
  }
  return out;
}
