// Copy of the wire contract from ../src/shared/types.ts + merge rules from docs/04-device-sync.md.
// Deliberately self-contained: Vercel deploys only hub/.

export type Source = "chrome" | "claude-code" | "desktop";
export const SOURCES: readonly Source[] = ["chrome", "claude-code", "desktop"];

export interface ModelAggregate { messages: number; tokens: number }
export interface WindowAggregate {
  messages: number;
  promptTokens: number;
  outputTokens: number;
  byModel: Record<string, ModelAggregate>;
}
export type WindowName = "today" | "last5h" | "last7d";
export const WINDOWS: readonly WindowName[] = ["today", "last5h", "last7d"];
export type Aggregates = Record<WindowName, WindowAggregate>;

export interface AccountWindow { name: string; utilization: number; resetsAt?: string }
export interface AccountUsage { fetchedAt: number; windows: AccountWindow[] }

export interface Report {
  v: 1;
  deviceId: string;
  deviceName: string;
  source: Source;
  sentAt: number;
  windows: Aggregates;
  estimated: boolean;
  account: AccountUsage | null;
}

export const FRESH_MS = 10 * 60 * 1000;
export const MAX_BODY = 64 * 1024;
export const LIM = { deviceId: 128, deviceName: 100, model: 100, accountName: 32, resetsAt: 40, models: 64, accountWindows: 32 };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;

function parseWindow(w: unknown): WindowAggregate | null {
  if (!isObj(w)) return null;
  if (!isNum(w.messages) || !isNum(w.promptTokens) || !isNum(w.outputTokens)) return null;
  if (!isObj(w.byModel)) return null;
  const keys = Object.keys(w.byModel);
  if (keys.length > LIM.models) return null;
  const byModel: Record<string, ModelAggregate> = {};
  for (const k of keys) {
    const m = w.byModel[k];
    if (!isStr(k, LIM.model, 1) || !isObj(m) || !isNum(m.messages) || !isNum(m.tokens)) return null;
    byModel[k] = { messages: m.messages, tokens: m.tokens };
  }
  return { messages: w.messages, promptTokens: w.promptTokens, outputTokens: w.outputTokens, byModel };
}

function parseAccount(a: unknown): AccountUsage | null | undefined {
  if (a === null || a === undefined) return null;
  if (!isObj(a) || !isNum(a.fetchedAt) || !Array.isArray(a.windows)) return undefined;
  if (a.windows.length > LIM.accountWindows) return undefined;
  const windows: AccountWindow[] = [];
  for (const w of a.windows) {
    if (!isObj(w) || !isStr(w.name, LIM.accountName, 1) || !isNum(w.utilization)) return undefined;
    if (w.resetsAt !== undefined && !isStr(w.resetsAt, LIM.resetsAt)) return undefined;
    windows.push({
      name: w.name,
      utilization: w.utilization,
      ...(typeof w.resetsAt === "string" ? { resetsAt: w.resetsAt } : {}),
    });
  }
  return { fetchedAt: a.fetchedAt, windows };
}

/** Strict validation. Returns a normalised Report, or null (-> HTTP 400). */
export function validateReport(r: unknown): Report | null {
  if (!isObj(r) || r.v !== 1) return null;
  if (!isStr(r.deviceId, LIM.deviceId, 1)) return null;
  if (!isStr(r.deviceName, LIM.deviceName)) return null;
  if (typeof r.source !== "string" || !SOURCES.includes(r.source as Source)) return null;
  if (!isNum(r.sentAt)) return null;
  if (typeof r.estimated !== "boolean") return null;
  if (!isObj(r.windows)) return null;
  const windows = {} as Aggregates;
  for (const k of WINDOWS) {
    const w = parseWindow(r.windows[k]);
    if (!w) return null;
    windows[k] = w;
  }
  const account = parseAccount(r.account);
  if (account === undefined) return null;
  return {
    v: 1,
    deviceId: r.deviceId,
    deviceName: r.deviceName,
    source: r.source as Source,
    sentAt: r.sentAt,
    windows,
    estimated: r.estimated,
    account,
  };
}

export interface StoredDevice {
  deviceId: string;
  deviceName: string;
  source: string;
  estimated: boolean;
  sentAt: number;
  receivedAt: number; // epoch ms
  windows: Aggregates;
}

/** A report is applied only if it is not older than the stored one. */
export function shouldApplyDevice(storedSentAt: number | null, incomingSentAt: number): boolean {
  return storedSentAt === null || incomingSentAt >= storedSentAt;
}

/** Account snapshot is replaced only if strictly newer. */
export function shouldApplyAccount(storedFetchedAt: number | null, incomingFetchedAt: number): boolean {
  return storedFetchedAt === null || incomingFetchedAt > storedFetchedAt;
}

export function isFresh(receivedAt: number, now = Date.now()): boolean {
  return now - receivedAt < FRESH_MS;
}

export interface MergedView {
  devices: (StoredDevice & { fresh: boolean })[];
  totals: Aggregates;
}

const emptyWindow = (): WindowAggregate => ({ messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} });

/** Totals sum fresh devices only (docs/04 merge rules). */
export function mergedView(devices: StoredDevice[], now = Date.now()): MergedView {
  const out = devices.map((d) => ({ ...d, fresh: isFresh(d.receivedAt, now) }));
  const totals = { today: emptyWindow(), last5h: emptyWindow(), last7d: emptyWindow() } as Aggregates;
  for (const d of out) {
    if (!d.fresh) continue;
    for (const k of WINDOWS) {
      const t = totals[k];
      const w = d.windows[k];
      t.messages += w.messages;
      t.promptTokens += w.promptTokens;
      t.outputTokens += w.outputTokens;
      for (const [m, v] of Object.entries(w.byModel)) {
        const c = (t.byModel[m] ??= { messages: 0, tokens: 0 });
        c.messages += v.messages;
        c.tokens += v.tokens;
      }
    }
  }
  return { devices: out, totals };
}

/** YYYY-MM-DD of an epoch-ms instant in an IANA timezone (falls back to UTC). */
export function dayInTz(ms: number, tz = "UTC"): string {
  const fmt = (z: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  try {
    return fmt(tz);
  } catch {
    return fmt("UTC");
  }
}
