// Plan limits straight from the Claude account, using the Claude Code OAuth sign-in on this PC.
// The credentials file is READ ONLY (never written/refreshed). The access token is held only in a local
// variable for the duration of one request, is sent only to https://api.anthropic.com, and is never logged,
// returned or stored.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, Plan } from "../../../src/shared/types";
import { parseAccountUsage } from "../../../src/sync/accountUsage";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const NOTE_REFRESH = "Open Claude Code once to refresh sign-in";
export const NOTE_SIGN_IN = "Sign in to Claude Code to see plan limits";
export const NOTE_OFFLINE = "Couldn't reach Anthropic";
export const NOTE_RATE_LIMIT = "Anthropic rate limit";
export const noteHttp = (status: number): string => `Anthropic error (HTTP ${status})`;

/** Retry-After: delta-seconds or HTTP date -> ms from `nowMs` (null when absent/unparseable). */
export function parseRetryAfter(v: string | null | undefined, nowMs: number): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.max(0, Math.round(Number(t) * 1000));
  const d = Date.parse(t);
  return Number.isFinite(d) ? Math.max(0, d - nowMs) : null;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

export type Credentials =
  | { status: "missing" }
  | { status: "invalid" } // file exists but has no usable token
  | { status: "ok"; token: string; expiresAt: number | null; plan: Plan | null };

export function planFromSubscription(s: unknown): Plan | null {
  if (typeof s !== "string") return null;
  const v = s.toLowerCase();
  for (const p of ["max", "pro", "team", "free"] as const) if (v.includes(p)) return p;
  return null;
}

/** Defensive, read-only parse. */
export function readCredentials(path: string): Credentials {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? { status: "missing" } : { status: "invalid" };
  }
  try {
    const o = (JSON.parse(text) as Record<string, any> | null)?.claudeAiOauth;
    if (!o || typeof o !== "object" || typeof o.accessToken !== "string" || !o.accessToken) return { status: "invalid" };
    const exp = typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : null;
    return { status: "ok", token: o.accessToken, expiresAt: exp, plan: planFromSubscription(o.subscriptionType) };
  } catch {
    return { status: "invalid" };
  }
}

export type AccountPoll =
  | { kind: "ok"; usage: AccountUsage; plan: Plan | null }
  | { kind: "none"; note: string } // no credentials file (hub may be used instead)
  | { kind: "error"; note: string; plan: Plan | null; httpStatus?: number; retryAfterMs?: number }; // keep the last reading, show the note

export interface AccountSourceOpts {
  path?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export function createAccountSource(opts: AccountSourceOpts = {}): { poll(): Promise<AccountPoll>; path: string } {
  const path = opts.path ?? credentialsPath();
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  return {
    path,
    async poll() {
      const c = readCredentials(path);
      if (c.status === "missing") return { kind: "none", note: NOTE_SIGN_IN };
      if (c.status === "invalid") return { kind: "error", note: NOTE_REFRESH, plan: null };
      if (c.expiresAt !== null && c.expiresAt < now()) return { kind: "error", note: NOTE_REFRESH, plan: c.plan };
      try {
        const res = await fetchFn(USAGE_URL, {
          headers: { Authorization: `Bearer ${c.token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json", "user-agent": "usage-meter-desktop/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) return { kind: "error", note: NOTE_REFRESH, plan: c.plan };
        if (res.status === 429) {
          const ra = parseRetryAfter(res.headers?.get?.("retry-after"), now());
          return { kind: "error", note: NOTE_RATE_LIMIT, plan: c.plan, httpStatus: 429, ...(ra !== null ? { retryAfterMs: ra } : {}) };
        }
        if (!res.ok) {
          const ra = parseRetryAfter(res.headers?.get?.("retry-after"), now());
          return { kind: "error", note: noteHttp(res.status), plan: c.plan, httpStatus: res.status, ...(ra !== null ? { retryAfterMs: ra } : {}) };
        }
        const usage = parseAccountUsage(await res.json().catch(() => null), now());
        if (!usage) return { kind: "error", note: NOTE_OFFLINE, plan: c.plan, httpStatus: res.status };
        return { kind: "ok", usage, plan: c.plan };
      } catch {
        return { kind: "error", note: NOTE_OFFLINE, plan: c.plan };
      }
    },
  };
}
