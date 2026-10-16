import { computeAggregates } from "../shared/aggregate";
import type { AccountUsage, DeviceInfo, Report, Source, UsageEvent } from "../shared/types";

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
    account,
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
