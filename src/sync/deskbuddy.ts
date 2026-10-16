import { computeAggregates } from "../shared/aggregate";
import type { AccountUsage, DeviceInfo, Report, UsageEvent } from "../shared/types";

const TIMEOUT_MS = 3000;

export function normalizeBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
  return u;
}

export function buildReport(
  device: DeviceInfo,
  events: UsageEvent[],
  account: AccountUsage | null,
  now = Date.now(),
): Report {
  return {
    v: 1,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    source: "chrome",
    sentAt: now,
    windows: computeAggregates(events, now),
    estimated: true,
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
  if (e instanceof Error && e.name === "AbortError") return "timed out after 3 s";
  return e instanceof Error ? e.message : String(e);
}

export async function sendReport(url: string, token: string, report: Report): Promise<SyncResult> {
  const base = normalizeBase(url);
  if (!base) return { ok: false, error: "No DeskBuddy URL set" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-DeskBuddy-Token"] = token;
  try {
    const res = await request(`${base}/api/report`, { method: "POST", headers, body: JSON.stringify(report) });
    if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true ? { ok: true } : { ok: false, error: "Unexpected response from DeskBuddy" };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function ping(url: string, token: string): Promise<SyncResult> {
  const base = normalizeBase(url);
  if (!base) return { ok: false, error: "No DeskBuddy URL set" };
  const headers: Record<string, string> = {};
  if (token) headers["X-DeskBuddy-Token"] = token;
  try {
    const res = await request(`${base}/api/ping`, { method: "GET", headers });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
