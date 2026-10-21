import { computeAggregates } from "../shared/aggregate";
import type { HubDevice, HubStateResult } from "../shared/messages";
import type { AccountUsage, Aggregates, DeviceInfo, Report, Source, UsageEvent, WindowAggregate } from "../shared/types";

const TIMEOUT_MS = 10_000;

/** Trims and strips trailing slashes. A bare host defaults to https://. */
export function normalizeBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  return u;
}

export function buildReport(
  device: DeviceInfo,
  events: UsageEvent[],
  account: AccountUsage | null,
  now = Date.now(),
  opts: { source: Source; estimated: boolean } = { source: "chrome", estimated: true },
): Report {
  return {
    v: 1,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    source: opts.source,
    sentAt: now,
    windows: computeAggregates(events, now),
    estimated: opts.estimated,
    account: account ? { fetchedAt: account.fetchedAt, windows: account.windows } : null, // breakdown stays local
  };
}

export interface SyncResult {
  ok: boolean;
  error?: string;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error && e.name === "AbortError") return "timed out after 10 s";
  return e instanceof Error ? e.message : String(e);
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function okBody(res: Response): Promise<boolean> {
  const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
  return body?.ok === true;
}

/** Success = HTTP 200 and {"ok":true}. */
export async function sendReport(url: string, token: string, report: Report): Promise<SyncResult> {
  const base = normalizeBase(url);
  if (!base) return { ok: false, error: "No hub URL set" };
  try {
    const res = await request(`${base}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(report),
    });
    if (res.status !== 200) return { ok: false, error: res.status === 401 ? "HTTP 401 (check hub token)" : `HTTP ${res.status}` };
    return (await okBody(res)) ? { ok: true } : { ok: false, error: "Unexpected response from hub" };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** GET /api/ping -> 200 {"ok":true}. */
export async function ping(url: string, token: string): Promise<SyncResult> {
  const base = normalizeBase(url);
  if (!base) return { ok: false, error: "No hub URL set" };
  try {
    const res = await request(`${base}/api/ping`, { method: "GET", headers: authHeaders(token) });
    if (res.status !== 200) return { ok: false, error: res.status === 401 ? "HTTP 401 (check hub token)" : `HTTP ${res.status}` };
    return (await okBody(res)) ? { ok: true } : { ok: false, error: "Unexpected response from hub" };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const SOURCES: Source[] = ["chrome", "claude-code", "desktop"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nn = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parseWindowAgg(w: unknown): WindowAggregate {
  const o = isObj(w) ? w : {};
  const byModel: WindowAggregate["byModel"] = {};
  if (isObj(o.byModel)) {
    for (const [k, v] of Object.entries(o.byModel).slice(0, 64)) {
      if (isObj(v)) byModel[k.slice(0, 100)] = { messages: nn(v.messages), tokens: nn(v.tokens) };
    }
  }
  return { messages: nn(o.messages), promptTokens: nn(o.promptTokens), outputTokens: nn(o.outputTokens), byModel };
}

/** Defensive parse of GET /api/state -> widget-sized device list. Never throws. */
export function parseHubState(body: unknown): HubDevice[] | null {
  if (!isObj(body) || body.ok !== true || !Array.isArray(body.devices)) return null;
  const out: HubDevice[] = [];
  for (const d of body.devices.slice(0, 50)) {
    if (!isObj(d) || typeof d.deviceId !== "string" || !d.deviceId) continue;
    const w = isObj(d.windows) ? d.windows : {};
    const windows: Aggregates = {
      today: parseWindowAgg(w.today),
      last5h: parseWindowAgg(w.last5h),
      last7d: parseWindowAgg(w.last7d),
    };
    out.push({
      deviceId: d.deviceId.slice(0, 128),
      deviceName: typeof d.deviceName === "string" ? d.deviceName.slice(0, 100) : "",
      source: SOURCES.includes(d.source as Source) ? (d.source as Source) : "chrome",
      estimated: d.estimated !== false,
      receivedAt: nn(d.receivedAt),
      fresh: d.fresh === true,
      windows,
    });
  }
  return out;
}

/** GET /api/state with Bearer auth. 10 s timeout, never throws. */
export async function fetchHubState(url: string, token: string): Promise<HubStateResult> {
  const fetchedAt = Date.now();
  const base = normalizeBase(url);
  if (!base) return { ok: false, error: "No hub URL set", fetchedAt, devices: [] };
  try {
    const res = await request(`${base}/api/state`, { method: "GET", headers: authHeaders(token) });
    if (res.status !== 200) {
      return { ok: false, error: res.status === 401 ? "HTTP 401 (check hub token)" : `HTTP ${res.status}`, fetchedAt, devices: [] };
    }
    const devices = parseHubState(await res.json().catch(() => null));
    if (!devices) return { ok: false, error: "Unexpected response from hub", fetchedAt, devices: [] };
    return { ok: true, fetchedAt, devices };
  } catch (e) {
    return { ok: false, error: errMsg(e), fetchedAt, devices: [] };
  }
}
