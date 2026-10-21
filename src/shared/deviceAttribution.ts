// Per-device attribution of plan-limit consumption (pure; no chrome.*, no DOM).
//
// Same interval logic as attribution.ts (each rise of a window's utilisation is split across the contributions
// seen since the previous reading, weighted by estimated cost), but keyed by DEVICE instead of model.
// Device keys are opaque strings: "local" = this browser, "hub:<deviceId>" = a Claude Code / Desktop device
// reported by the Usage Hub, later "session:<hash>" for sessions-list rows.
// Besides the points we remember how many of them came from intervals with 2+ active devices (a guess, so low
// confidence). Invariant: sum(rows) + unattributed ~= current utilisation for each window.

import {
  ATTR_WINDOWS, addContribution, applyReading, emptyLedger, normalizeLedger, tokenWeight,
  type AttrWindow, type Ledger, type WindowLedger,
} from "./attribution";

export const LOCAL_KEY = "local";
const MAX_HUB_DEVICES = 50;
const MAX_NAME_LEN = 80;
const MIN_ROW_PTS = 0.05;

export interface DeviceLedger {
  /** attribution.ts ledger whose "model" keys are device keys */
  ledger: Ledger;
  /** points per key that came from intervals with >= 2 active devices */
  splitPts: Partial<Record<AttrWindow, Record<string, number>>>;
  /** cycle (resetsAt) the splitPts belong to */
  cycle: Partial<Record<AttrWindow, string>>;
  /** last seen total weighted hub tokens per hub device (own copy, not ledger.hubPrev) */
  hubPrev: Record<string, number>;
  /** device key -> last known display name (so a hub that is unreachable or forgot a device doesn't leave a raw key) */
  names: Record<string, string>;
}

export interface DeviceRow {
  key: string;
  label: string;
  pts: number;
  share: number;
  confidence: "high" | "low";
}

export interface DeviceWindowView {
  cycle: string;
  /** whole window utilisation: rows + unattributed */
  totalPts: number;
  unattributedPts: number;
  rows: DeviceRow[];
  baselineEstimated?: boolean;
}

export type DeviceView = Partial<Record<AttrWindow, DeviceWindowView>>;

export interface HubDeviceInput {
  deviceId: string;
  source: string;
  last5hByModel: Record<string, number>;
  deviceName?: string;
}

export function emptyDeviceLedger(): DeviceLedger {
  return { ledger: emptyLedger(), splitPts: {}, cycle: {}, hubPrev: {}, names: {} };
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
    out.ledger = normalizeLedger(raw.ledger);
    if (isObj(raw.splitPts)) for (const w of ATTR_WINDOWS) if (isObj(raw.splitPts[w])) out.splitPts[w] = numRecord(raw.splitPts[w]);
    if (isObj(raw.cycle)) for (const w of ATTR_WINDOWS) if (typeof raw.cycle[w] === "string") out.cycle[w] = raw.cycle[w] as string;
    out.hubPrev = numRecord(raw.hubPrev);
    out.names = nameRecord(raw.names);
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

const sumOf = (w: WindowLedger): number => Object.values(w.byModel).reduce((a, b) => a + b, 0) + w.other;

/** Applies one account-usage reading; also tracks which points came from multi-device (ambiguous) intervals. */
export function applyDeviceReading(
  dl: DeviceLedger,
  usage: { windows: { name: string; utilization: number; resetsAt?: string }[] } | null | undefined,
  now: number,
): DeviceLedger {
  const before = dl.ledger;
  const after = applyReading(before, usage, now);
  if (after === before) return dl;
  const splitPts: DeviceLedger["splitPts"] = { ...dl.splitPts };
  const cycle: DeviceLedger["cycle"] = { ...dl.cycle };
  for (const name of ATTR_WINDOWS) {
    const aw = after.windows[name];
    if (!aw) continue;
    const bw = before.windows[name];
    const pendingKeys = Object.values(before.pendingW[name] ?? {}).filter((v) => v > 0).length;
    const multi = pendingKeys >= 2;
    const cur: Record<string, number> = {};
    if (!bw || bw !== aw && bw.cycle !== aw.cycle) {
      // new cycle: its first points (if any were distributed) are split when 2+ devices were pending
      if (bw && multi) for (const [k, v] of Object.entries(aw.byModel)) cur[k] = v;
    } else {
      Object.assign(cur, dl.cycle[name] === aw.cycle ? dl.splitPts[name] ?? {} : {});
      const tb = sumOf(bw);
      const ta = sumOf(aw);
      if (ta < tb - 1e-9 && tb > 0) {
        const k = ta / tb; // utilisation dropped: everything was scaled by the same factor
        for (const key of Object.keys(cur)) cur[key] *= k;
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
    splitPts[name] = cur;
    cycle[name] = aw.cycle;
  }
  return { ...dl, ledger: after, splitPts, cycle };
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
    const rows: DeviceRow[] = [];
    for (const [key, pts] of Object.entries(w.byModel)) {
      if (!(pts >= MIN_ROW_PTS)) continue;
      rows.push({
        key,
        label: labels[key] ?? dl.names[key] ?? (key.startsWith("hub:") ? "Other device" : key),
        pts,
        share: totalPts > 0 ? pts / totalPts : 0,
        confidence: (split[key] ?? 0) / pts >= 0.5 ? "low" : "high",
      });
    }
    rows.sort((a, b) => b.pts - a.pts);
    out[name] = { cycle: w.cycle, totalPts, unattributedPts: w.other, rows, ...(w.baselineEstimated ? { baselineEstimated: true } : {}) };
  }
  return out;
}
