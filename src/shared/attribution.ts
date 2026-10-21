// Per-model attribution of plan-limit consumption (pure; no chrome.*, no DOM).
//
// The account usage endpoint only gives a total utilisation per window (5h / weekly). We watch that number
// move after each reply and split every increase between the replies (contributions) that happened since the
// previous reading, weighted by an estimate of their cost. The result is an ESTIMATE in percentage points.
// Invariant: sum(byModel) + other ~= current utilisation for each window.

export const ATTR_WINDOWS = ["five_hour", "seven_day"] as const;
export type AttrWindow = (typeof ATTR_WINDOWS)[number];

export type ContributionSource = "chrome" | "hub" | "local";

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
  /** true when the starting utilisation was split across local events (estimate) instead of going to `other` */
  baselineEstimated?: boolean;
}

export type PendingWeights = Record<string, number>;

export interface Ledger {
  windows: Partial<Record<AttrWindow, WindowLedger>>;
  /** Per window: summed reply weight per model since that window's utilisation last rose. */
  pendingW: Partial<Record<AttrWindow, PendingWeights>>;
  lastReadingAt: number;
  /** last seen last5h tokens per hub device and model, to turn snapshots into deltas */
  hubPrev: Record<string, Record<string, number>>;
}

/** What the widget needs. */
export type AttributionView = Partial<Record<AttrWindow, { byModel: Record<string, number>; other: number; baselineEstimated?: boolean }>>;

export const WINDOW_MS: Record<AttrWindow, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 };

/** Optional hook: weights per model of the replies already inside the current cycle (used for the first-sight split). */
export interface ApplyOptions {
  baseline?: (window: AttrWindow, cycleStartMs: number) => Record<string, number>;
}

export const CYCLE_TOLERANCE_MS = 120_000;
const MAX_HUB_DEVICES = 50;

export function emptyLedger(): Ledger {
  return { windows: {}, pendingW: {}, lastReadingAt: 0, hubPrev: {} };
}

/** Tolerant loader for a stored ledger; migrates the old `pending` contribution list into `pendingW`. */
export function normalizeLedger(raw: unknown): Ledger {
  const base = emptyLedger();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out: Ledger = {
    windows: r.windows && typeof r.windows === "object" ? (r.windows as Ledger["windows"]) : base.windows,
    pendingW: r.pendingW && typeof r.pendingW === "object" ? (r.pendingW as Ledger["pendingW"]) : {},
    lastReadingAt: typeof r.lastReadingAt === "number" ? r.lastReadingAt : 0,
    hubPrev: r.hubPrev && typeof r.hubPrev === "object" ? (r.hubPrev as Ledger["hubPrev"]) : {},
  };
  if (Array.isArray(r.pending)) {
    const sums: PendingWeights = {};
    for (const c of r.pending as Partial<Contribution>[]) {
      if (c && typeof c.model === "string" && typeof c.weight === "number" && c.weight > 0 && Number.isFinite(c.weight)) {
        sums[c.model] = (sums[c.model] ?? 0) + c.weight;
      }
    }
    if (Object.keys(sums).length) for (const w of ATTR_WINDOWS) out.pendingW[w] = { ...sums, ...(out.pendingW[w] ?? {}) };
  }
  return out;
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
  const weight = Math.max(c.weight, 1e-9);
  const pendingW: Ledger["pendingW"] = { ...l.pendingW };
  for (const w of ATTR_WINDOWS) {
    const cur = { ...(pendingW[w] ?? {}) };
    cur[c.model] = (cur[c.model] ?? 0) + weight;
    pendingW[w] = cur;
  }
  return { ...l, pendingW };
}

const total = (w: WindowLedger): number => Object.values(w.byModel).reduce((a, b) => a + b, 0) + w.other;

function sameCycle(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= CYCLE_TOLERANCE_MS;
}

/** Adds `delta` points to `w`, split across pending weights (or to `other` when there are none). */
function distribute(w: WindowLedger, delta: number, pending: PendingWeights | undefined): void {
  const entries = Object.entries(pending ?? {}).filter(([, v]) => v > 0);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (!entries.length || !(sum > 0)) {
    w.other += delta;
    return;
  }
  for (const [m, v] of entries) w.byModel[m] = (w.byModel[m] ?? 0) + (delta * v) / sum;
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
 * Each window consumes its own pending weights, and only when its utilisation actually rose (or a new cycle
 * began): the server often lags a few seconds behind a reply, so a zero delta must keep the replies pending.
 */
export function applyReading(
  ledger: Ledger,
  usage: { windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  now: number,
  opts?: ApplyOptions,
): Ledger {
  if (!usage) return ledger;
  if (now < ledger.lastReadingAt) return ledger; // out-of-order (stale) reading
  const windows: Ledger["windows"] = { ...ledger.windows };
  const pendingW: Ledger["pendingW"] = { ...ledger.pendingW };
  let touched = false;
  for (const name of ATTR_WINDOWS) {
    const aw = usage.windows.find((w) => w.name === name);
    if (!aw || !Number.isFinite(aw.utilization)) continue;
    touched = true;
    const util = Math.min(100, Math.max(0, aw.utilization));
    const cycle = aw.resetsAt ?? "";
    const prev = windows[name];
    const pend = pendingW[name];
    if (!prev || !sameCycle(prev.cycle, cycle)) {
      const fresh: WindowLedger = { cycle, lastUtil: util, byModel: {}, other: 0 };
      // First sight: whatever is already used happened before tracking (pending replies are inside it).
      // Rollover: the new cycle's first points can only come from replies we just saw.
      if (prev && util > 0 && Object.values(pend ?? {}).some((v) => v > 0)) distribute(fresh, util, pend);
      else if (util > 0 && opts?.baseline && Number.isFinite(Date.parse(cycle))) {
        let weights: PendingWeights = {};
        try {
          weights = opts.baseline(name, Date.parse(cycle) - WINDOW_MS[name]) ?? {};
        } catch {
          /* fall back to other */
        }
        const before = fresh.other;
        distribute(fresh, util, weights);
        if (fresh.other === before) fresh.baselineEstimated = true;
      } else fresh.other = util;
      windows[name] = fresh;
      delete pendingW[name];
      continue;
    }
    const w: WindowLedger = { cycle: prev.cycle, lastUtil: util, byModel: { ...prev.byModel }, other: prev.other, ...(prev.baselineEstimated ? { baselineEstimated: true } : {}) };
    const delta = util - (prev.lastUtil ?? util);
    if (delta > 0) {
      distribute(w, delta, pend);
      delete pendingW[name];
    } else if (delta < 0) scaleTo(w, util);
    windows[name] = w;
  }
  if (!touched) return ledger;
  return { ...ledger, windows, pendingW, lastReadingAt: now };
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
    if (w) out[name] = { byModel: { ...w.byModel }, other: w.other, ...(w.baselineEstimated ? { baselineEstimated: true } : {}) };
  }
  return out;
}
