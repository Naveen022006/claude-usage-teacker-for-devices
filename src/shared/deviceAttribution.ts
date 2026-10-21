// Per-device attribution of plan-limit consumption (pure; no chrome.*, no DOM).
//
// Same interval logic as attribution.ts (each rise of a window's utilisation is split across the contributions
// seen since the previous reading, weighted by estimated cost), but keyed by DEVICE instead of model.
// Device keys are opaque strings: "local" = this browser, "hub:<deviceId>" = a Claude Code / Desktop device
// reported by the Usage Hub, later "session:<hash>" for sessions-list rows.
// Besides the points we remember how many of them came from intervals with 2+ active devices (a guess, so low
// confidence). Invariant: sum(rows) + unattributed ~= current utilisation for each window.

import {
  ATTR_WINDOWS, CYCLE_TOLERANCE_MS, addContribution, applyReading, emptyLedger, normalizeLedger, replyWeight, tokenWeight,
  type AttrWindow, type Ledger, type WindowLedger,
} from "./attribution";
import type { UsageEvent } from "./types";

/** Bump to force a re-baseline: older stored ledgers load as empty (names kept). */
export const DEVICE_LEDGER_VERSION = 2;

export const LOCAL_KEY = "local";
const MAX_HUB_DEVICES = 50;
const MAX_NAME_LEN = 80;
const MAX_METHOD_KEYS = 100;
const MIN_ROW_PTS = 0.05;

export interface DeviceLedger {
  version: number;
  /** attribution.ts ledger whose "model" keys are device keys */
  ledger: Ledger;
  /** points per key that came from intervals with >= 2 active devices */
  splitPts: Partial<Record<AttrWindow, Record<string, number>>>;
  /** points per key that came from the pre-tracking estimate (first sight of the cycle) */
  baselinePts: Partial<Record<AttrWindow, Record<string, number>>>;
  /** cycle (resetsAt) the splitPts / baselinePts belong to */
  cycle: Partial<Record<AttrWindow, string>>;
  /** last seen total weighted hub tokens per hub device (own copy, not ledger.hubPrev) */
  hubPrev: Record<string, number>;
  /** device key -> last known display name (so a hub that is unreachable or forgot a device doesn't leave a raw key) */
  names: Record<string, string>;
  /** time (ms) tracking began for the current cycle of each window (set on first sight / cycle change) */
  since: Partial<Record<AttrWindow, number>>;
  /** device key -> evidence kind when weaker than events/tokens ("updated" = only the sessions-list Updated moved) */
  method: Record<string, "updated">;
}

export interface DeviceRow {
  key: string;
  label: string;
  pts: number;
  share: number;
  confidence: "high" | "medium" | "low";
  /** this device has replies whose weight is still waiting for the usage % to move */
  waiting: boolean;
  /** most of this row's points are an estimate of activity before tracking started */
  estimated?: boolean;
}

export interface DeviceWindowView {
  cycle: string;
  /** whole window utilisation: rows + unattributed */
  totalPts: number;
  unattributedPts: number;
  rows: DeviceRow[];
  baselineEstimated?: boolean;
  /** ms epoch when tracking began for this cycle (undefined for ledgers stored before this field existed) */
  trackingSince?: number;
}

export type DeviceView = Partial<Record<AttrWindow, DeviceWindowView>>;

export interface HubDeviceInput {
  deviceId: string;
  source: string;
  last5hByModel: Record<string, number>;
  deviceName?: string;
}

export function emptyDeviceLedger(): DeviceLedger {
  return { version: DEVICE_LEDGER_VERSION, ledger: emptyLedger(), splitPts: {}, baselinePts: {}, cycle: {}, hubPrev: {}, names: {}, since: {}, method: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = n;
  return out;
}

function nameRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_HUB_DEVICES) break;
    if (typeof n === "string" && n.length <= MAX_NAME_LEN) out[k] = n;
  }
  return out;
}

/** Tolerant loader for a stored device ledger; never throws. */
export function normalizeDeviceLedger(raw: unknown): DeviceLedger {
  const out = emptyDeviceLedger();
  try {
    if (!isObj(raw)) return out;
    if (typeof raw.version !== "number" || raw.version < DEVICE_LEDGER_VERSION) {
      out.names = nameRecord(raw.names); // re-baseline: the next reading is a first sight; keep the names
      return out;
    }
    out.ledger = normalizeLedger(raw.ledger);
    if (isObj(raw.splitPts)) for (const w of ATTR_WINDOWS) if (isObj(raw.splitPts[w])) out.splitPts[w] = numRecord(raw.splitPts[w]);
    if (isObj(raw.cycle)) for (const w of ATTR_WINDOWS) if (typeof raw.cycle[w] === "string") out.cycle[w] = raw.cycle[w] as string;
    if (isObj(raw.baselinePts)) for (const w of ATTR_WINDOWS) if (isObj(raw.baselinePts[w])) out.baselinePts[w] = numRecord(raw.baselinePts[w]);
    out.hubPrev = numRecord(raw.hubPrev);
    out.names = nameRecord(raw.names);
    if (isObj(raw.method)) {
      for (const [k, v] of Object.entries(raw.method)) {
        if (Object.keys(out.method).length >= MAX_METHOD_KEYS) break;
        if (v === "updated") out.method[k] = "updated";
      }
    }
    if (isObj(raw.since)) for (const w of ATTR_WINDOWS) {
      const t = raw.since[w];
      if (typeof t === "number" && Number.isFinite(t) && t > 0) out.since[w] = t;
    }
  } catch {
    return emptyDeviceLedger();
  }
  return out;
}

export function addDeviceContribution(dl: DeviceLedger, key: string, weight: number, ts: number): DeviceLedger {
  const source = key.startsWith("hub:") ? "hub" : "local";
  const ledger = addContribution(dl.ledger, { model: key, weight, ts, source });
  return ledger === dl.ledger ? dl : { ...dl, ledger };
}

function sameCycleStr(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= CYCLE_TOLERANCE_MS;
}

/**
 * Evidence source 3: sessions-list rows whose Updated moved since the previous poll (devices without the extension).
 * Call right BEFORE applyDeviceReading with the same reading. Does nothing unless that reading shows a rise in an
 * attributed window (same cycle), so an Updated change without usage never leaves stale pending weight.
 * Weight = mean of the positive pending weights of other keys (five_hour, else seven_day), or 1 when there are none.
 */
export function addSessionActivity(
  dl: DeviceLedger,
  keys: string[],
  usage: { windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  now: number,
): DeviceLedger {
  if (!usage || !keys.length) return dl;
  let rise = false;
  for (const name of ATTR_WINDOWS) {
    const aw = usage.windows.find((w) => w.name === name);
    const lw = dl.ledger.windows[name];
    if (!aw || !lw || !Number.isFinite(aw.utilization) || lw.lastUtil === null) continue;
    if (!sameCycleStr(lw.cycle, aw.resetsAt ?? "")) continue;
    if (Math.min(100, Math.max(0, aw.utilization)) > lw.lastUtil + 1e-9) rise = true;
  }
  if (!rise) return dl;
  const sessionKeys = [...new Set(keys.filter((k) => typeof k === "string" && k.startsWith("session:")))];
  if (!sessionKeys.length) return dl;
  const others = (name: AttrWindow): number[] =>
    Object.entries(dl.ledger.pendingW[name] ?? {}).filter(([k, v]) => v > 0 && !sessionKeys.includes(k)).map(([, v]) => v);
  let vals = others("five_hour");
  if (!vals.length) vals = others("seven_day");
  const weight = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  const method = { ...dl.method };
  let next: DeviceLedger = dl;
  for (const k of sessionKeys) {
    delete method[k];
    method[k] = "updated";
    next = addDeviceContribution(next, k, weight, now);
  }
  const mk = Object.keys(method);
  if (mk.length > MAX_METHOD_KEYS) for (const k of mk.slice(0, mk.length - MAX_METHOD_KEYS)) delete method[k];
  return { ...next, method };
}

/** Remembers display names for device keys (same caps/validation as hub names). */
export function rememberNames(dl: DeviceLedger, names: Record<string, string>): DeviceLedger {
  const merged = { ...dl.names };
  let changed = false;
  for (const [k, raw] of Object.entries(names ?? {})) {
    const n = typeof raw === "string" ? raw.trim() : "";
    if (!n || n.length > MAX_NAME_LEN || merged[k] === n) continue;
    delete merged[k];
    merged[k] = n;
    changed = true;
  }
  if (!changed) return dl;
  const nk = Object.keys(merged);
  if (nk.length > MAX_HUB_DEVICES) for (const k of nk.slice(0, nk.length - MAX_HUB_DEVICES)) delete merged[k];
  return { ...dl, names: merged };
}

/**
 * One account-usage reading plus the sessions-list evidence. Order matters: addSessionActivity must see the ledger
 * BEFORE the reading is applied (it checks for a rise against the previous reading and queues pending weight).
 */
export function applyReadingWithSessions(
  dl: DeviceLedger,
  usage: { fetchedAt: number; windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  changed: string[],
  names: Record<string, string>,
  now: number,
  baseline?: BaselineFn,
): DeviceLedger {
  return applyDeviceReading(addSessionActivity(rememberNames(dl, names), changed, usage, now), usage, usage?.fetchedAt ?? now, baseline);
}

export interface BaselineHubDevice {
  deviceId: string;
  source: string;
  last5hByModel: Record<string, number>;
  last7dByModel: Record<string, number>;
}

export type BaselineFn = (w: AttrWindow, cycleStartMs: number) => Record<string, number>;

/**
 * Weights of the activity that happened in the current cycle BEFORE tracking started, per device key.
 * local = this browser's stored events in [cycleStart, now]; hub:<id> = that device's tokens in the window;
 * session:<key> = every non-current stored session updated since the cycle start (fallback weight).
 * Fallback = mean of the positive weights (1 when there are none). All-zero result = {} (stays Unattributed).
 */
export function baselineWeights(a: {
  events: UsageEvent[];
  ownDeviceId: string | null;
  hubDevices: BaselineHubDevice[];
  sessions: Record<string, { lastUpdated: string; current: boolean }>;
  window: AttrWindow;
  cycleStartMs: number;
  now: number;
}): Record<string, number> {
  const out: Record<string, number> = {};
  let local = 0;
  for (const e of a.events ?? []) {
    if (!e || e.source !== "chrome" || e.deviceId !== a.ownDeviceId) continue;
    if (!(e.ts >= a.cycleStartMs && e.ts <= a.now)) continue;
    local += replyWeight(e.model, e.promptTokens, e.outputTokens);
  }
  const positives: number[] = [];
  if (local > 0) positives.push(local);
  for (const d of a.hubDevices ?? []) {
    if (a.ownDeviceId !== null && d.deviceId === a.ownDeviceId) continue;
    if (d.source !== "claude-code" && d.source !== "desktop" && d.source !== "chrome") continue;
    let t = 0;
    for (const [m, n] of Object.entries((a.window === "five_hour" ? d.last5hByModel : d.last7dByModel) ?? {})) t += tokenWeight(m, n);
    if (t > 0) {
      out["hub:" + d.deviceId] = t;
      positives.push(t);
    }
  }
  const fallback = positives.length ? positives.reduce((x, y) => x + y, 0) / positives.length : 1;
  let currentActive = false;
  const sessionKeys: string[] = [];
  for (const [k, s] of Object.entries(a.sessions ?? {})) {
    const t = Date.parse(s?.lastUpdated);
    if (!Number.isFinite(t) || t < a.cycleStartMs) continue;
    if (s.current) currentActive = true;
    else sessionKeys.push(k);
  }
  if (local > 0) out[LOCAL_KEY] = local;
  else if (currentActive) out[LOCAL_KEY] = fallback;
  for (const k of sessionKeys) out[k] = fallback;
  return Object.values(out).some((v) => v > 0) ? out : {};
}

const sumOf = (w: WindowLedger): number => Object.values(w.byModel).reduce((a, b) => a + b, 0) + w.other;

/** Applies one account-usage reading; also tracks which points came from multi-device (ambiguous) intervals. */
export function applyDeviceReading(
  dl: DeviceLedger,
  usage: { windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  now: number,
  baseline?: BaselineFn,
): DeviceLedger {
  const before = dl.ledger;
  const after = applyReading(before, usage, now, baseline ? { baseline } : undefined);
  if (after === before) return dl;
  const splitPts: DeviceLedger["splitPts"] = { ...dl.splitPts };
  const baselinePts: DeviceLedger["baselinePts"] = { ...dl.baselinePts };
  const cycle: DeviceLedger["cycle"] = { ...dl.cycle };
  const since: DeviceLedger["since"] = { ...dl.since };
  for (const name of ATTR_WINDOWS) {
    const aw = after.windows[name];
    if (!aw) continue;
    const bw = before.windows[name];
    const pendingKeys = Object.values(before.pendingW[name] ?? {}).filter((v) => v > 0).length;
    const multi = pendingKeys >= 2;
    const cur: Record<string, number> = {};
    const base: Record<string, number> = {};
    if (!bw || bw !== aw && bw.cycle !== aw.cycle) {
      // new cycle: its first points (if any were distributed) are split when 2+ devices were pending
      if (bw && multi) for (const [k, v] of Object.entries(aw.byModel)) cur[k] = v;
      else if (aw.baselineEstimated) for (const [k, v] of Object.entries(aw.byModel)) base[k] = v;
    } else {
      Object.assign(base, dl.cycle[name] === aw.cycle ? dl.baselinePts[name] ?? {} : {});
      Object.assign(cur, dl.cycle[name] === aw.cycle ? dl.splitPts[name] ?? {} : {});
      const tb = sumOf(bw);
      const ta = sumOf(aw);
      if (ta < tb - 1e-9 && tb > 0) {
        const k = ta / tb; // utilisation dropped: everything was scaled by the same factor
        for (const key of Object.keys(cur)) cur[key] *= k;
        for (const key of Object.keys(base)) base[key] *= k;
      } else if (multi) {
        for (const [key, v] of Object.entries(aw.byModel)) {
          const inc = v - (bw.byModel[key] ?? 0);
          if (inc > 0) cur[key] = (cur[key] ?? 0) + inc;
        }
      }
    }
    for (const key of Object.keys(cur)) {
      cur[key] = Math.min(cur[key], aw.byModel[key] ?? 0);
      if (!(cur[key] > 0)) delete cur[key];
    }
    for (const key of Object.keys(base)) {
      base[key] = Math.min(base[key], aw.byModel[key] ?? 0);
      if (!(base[key] > 0)) delete base[key];
    }
    splitPts[name] = cur;
    baselinePts[name] = base;
    if (!bw || bw.cycle !== aw.cycle || since[name] === undefined) since[name] = now;
    cycle[name] = aw.cycle;
  }
  return { ...dl, ledger: after, splitPts, baselinePts, cycle, since };
}

/**
 * Turns hub snapshots into device contributions. The first sight of a device only records a baseline; a negative
 * delta (the 5h window rolled over) just resets it. Every hub device counts (claude-code, desktop and OTHER Chrome
 * installs) except `selfDeviceId`: this browser's replies are captured locally under LOCAL_KEY, so counting its own
 * hub report as well would double-count it.
 */
export function recordHubDevices(dl: DeviceLedger, devices: HubDeviceInput[], now: number, selfDeviceId: string | null): DeviceLedger {
  const hubPrev = { ...dl.hubPrev };
  const names = { ...dl.names };
  const adds: { key: string; weight: number }[] = [];
  for (const d of devices) {
    if (selfDeviceId !== null && d.deviceId === selfDeviceId) continue;
    if (d.source !== "claude-code" && d.source !== "desktop" && d.source !== "chrome") continue;
    const name = typeof d.deviceName === "string" ? d.deviceName.trim() : "";
    if (name && name.length <= MAX_NAME_LEN) {
      delete names["hub:" + d.deviceId];
      names["hub:" + d.deviceId] = name;
    }
    let total = 0;
    for (const [m, t] of Object.entries(d.last5hByModel ?? {})) total += tokenWeight(m, t);
    const prev = hubPrev[d.deviceId];
    if (prev !== undefined) {
      const delta = total - prev;
      if (delta > 0) adds.push({ key: "hub:" + d.deviceId, weight: delta });
    }
    delete hubPrev[d.deviceId]; // re-insert so the newest devices sit last when trimming
    hubPrev[d.deviceId] = total;
  }
  const keys = Object.keys(hubPrev);
  if (keys.length > MAX_HUB_DEVICES) for (const k of keys.slice(0, keys.length - MAX_HUB_DEVICES)) delete hubPrev[k];
  const nameKeys = Object.keys(names);
  if (nameKeys.length > MAX_HUB_DEVICES) for (const k of nameKeys.slice(0, nameKeys.length - MAX_HUB_DEVICES)) delete names[k];
  let next: DeviceLedger = { ...dl, hubPrev, names };
  for (const a of adds) next = addDeviceContribution(next, a.key, a.weight, now);
  return next;
}

/** What the widget needs: per window, rows per device sorted by points. */
export function deviceView(dl: DeviceLedger, labels: Record<string, string>): DeviceView {
  const out: DeviceView = {};
  for (const name of ATTR_WINDOWS) {
    const w = dl.ledger.windows[name];
    if (!w) continue;
    const totalPts = sumOf(w);
    const split = dl.cycle[name] === w.cycle ? dl.splitPts[name] ?? {} : {};
    const basePts = dl.cycle[name] === w.cycle ? dl.baselinePts[name] ?? {} : {};
    const pending = dl.ledger.pendingW[name] ?? {};
    const rows: DeviceRow[] = [];
    const keys = new Set<string>([LOCAL_KEY, ...Object.keys(w.byModel), ...Object.keys(pending)]);
    for (const key of keys) {
      const pts = w.byModel[key] ?? 0;
      const waiting = (pending[key] ?? 0) > 0;
      if (!(pts >= MIN_ROW_PTS) && !waiting && key !== LOCAL_KEY) continue;
      const estimated = pts > 0 && (basePts[key] ?? 0) / pts >= 0.5;
      rows.push({
        key,
        label: labels[key] ?? dl.names[key] ?? (key.startsWith("hub:") ? "Other device" : key.startsWith("session:") ? "Signed-in device" : key),
        pts,
        share: totalPts > 0 ? pts / totalPts : 0,
        confidence: estimated || (pts > 0 && (split[key] ?? 0) / pts >= 0.5) ? "low" : dl.method[key] === "updated" ? "medium" : "high",
        waiting,
        ...(estimated ? { estimated: true } : {}),
      });
    }
    rows.sort((a, b) => b.pts - a.pts);
    out[name] = { cycle: w.cycle, totalPts, unattributedPts: w.other, rows, ...(w.baselineEstimated ? { baselineEstimated: true } : {}), ...(dl.since[name] !== undefined ? { trackingSince: dl.since[name] } : {}) };
  }
  return out;
}
