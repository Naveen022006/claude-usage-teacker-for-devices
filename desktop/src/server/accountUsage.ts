// Plan limits straight from a Claude account, using Claude Code OAuth credentials on this PC:
//   1. the tray-owned sign-in (isolated CLAUDE_CONFIG_DIR, made with `claude auth login` from the tray menu), else
//   2. the user's normal Claude Code CLI sign-in (%USERPROFILE%\.claude\.credentials.json).
// Credentials files are READ ONLY (never written/refreshed by us; a refresh is delegated to the official CLI via
// `claude auth status`). The access token is held only in a local variable for the duration of one request, is sent only
// to https://api.anthropic.com, and is never logged, returned or stored.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountUsage, Plan } from "../../../src/shared/types";
import { parseAccountUsage } from "../../../src/sync/accountUsage";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const NOTE_REFRESH = "Open Claude Code once to refresh sign-in";
export const NOTE_SIGN_IN = "Sign in to Claude Code to see plan limits";
export const NOTE_CLI = "Showing Claude Code CLI account — sign in with your Claude Desktop account from the tray menu";
export const NOTE_TRAY_SIGN_IN = "Sign in again from the tray menu (Claude Desktop account)";
export const NOTE_OFFLINE = "Couldn't reach Anthropic";
export const NOTE_RATE_LIMIT = "Anthropic rate limit";
export const SILENT_REFRESH_MIN_GAP_MS = 10 * 60_000;
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

/** %APPDATA%\UsageMeterDesktop\claude-auth (the tray's isolated CLAUDE_CONFIG_DIR). */
export function trayAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "UsageMeterDesktop", "claude-auth");
}

export type AccountKind = "tray" | "cli";

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

/** Runs `claude auth status` against the isolated config dir so the CLI can refresh its own token. Output is discarded. */
export type RefreshSpawn = (configDir: string) => Promise<void>;

export const defaultRefreshSpawn: RefreshSpawn = (configDir) =>
  new Promise<void>((resolve) => {
    try {
      mkdirSync(configDir, { recursive: true });
      const child = spawn("claude", ["auth", "status"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        windowsHide: true,
        stdio: "ignore", // never keep stdout/stderr: they could contain secrets
        shell: process.platform === "win32",
        timeout: 30_000,
      });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch {
      resolve();
    }
  });

export interface AccountIdentity {
  accountKind: AccountKind | null;
  plan: Plan | null;
  /** Hash of the account identity (not a secret); changes when the signed-in account changes. */
  fingerprint: string | null;
}

export type AccountPoll =
  | { kind: "ok"; usage: AccountUsage; plan: Plan | null; accountKind: AccountKind; fingerprint: string | null }
  | { kind: "none"; note: string } // no credentials file (hub may be used instead)
  | { kind: "error"; note: string; plan: Plan | null; accountKind?: AccountKind; fingerprint?: string | null; httpStatus?: number; retryAfterMs?: number }; // keep the last reading, show the note

export interface AccountSourceOpts {
  /** Claude Code CLI credentials file (fallback). */
  path?: string;
  /** Isolated tray-owned CLAUDE_CONFIG_DIR; undefined = %APPDATA%\UsageMeterDesktop\claude-auth; null = disabled. */
  trayDir?: string | null;
  spawnFn?: RefreshSpawn;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface AccountSource {
  poll(): Promise<AccountPoll>;
  path: string;
  /** Which credentials would be used right now (sync, no network, no secrets). */
  inspect(): AccountIdentity;
  /** Changes whenever a credentials file appears, disappears or is rewritten (sign-in / sign-out). */
  stamp(): string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** accountUuid / email from .claude.json if present. Read only. */
function identityFrom(files: string[]): string | null {
  for (const f of files) {
    try {
      const o = (JSON.parse(readFileSync(f, "utf8")) as Record<string, any>)?.oauthAccount;
      const id = o && (o.accountUuid || o.emailAddress);
      if (typeof id === "string" && id) return id;
    } catch {
      /* none */
    }
  }
  return null;
}

function mtimeOf(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

type Picked = { kind: "tray" | "cli"; c: Extract<Credentials, { status: "ok" }>; dir: string } | { kind: null };

export function createAccountSource(opts: AccountSourceOpts = {}): AccountSource {
  const path = opts.path ?? credentialsPath();
  const trayDir = opts.trayDir === undefined ? trayAuthDir() : opts.trayDir;
  const trayPath = trayDir ? join(trayDir, ".credentials.json") : null;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const spawnFn = opts.spawnFn ?? defaultRefreshSpawn;
  let lastSilentRefresh: number | null = null;

  async function silentRefresh(): Promise<void> {
    if (!trayDir) return;
    const t = now();
    if (lastSilentRefresh !== null && t - lastSilentRefresh < SILENT_REFRESH_MIN_GAP_MS) return;
    lastSilentRefresh = t;
    try {
      await spawnFn(trayDir);
    } catch {
      /* ignore */
    }
  }

  function pick(): Picked {
    if (trayPath && trayDir) {
      const t = readCredentials(trayPath);
      if (t.status === "ok") return { kind: "tray", c: t, dir: trayDir };
    }
    const c = readCredentials(path);
    if (c.status === "ok") return { kind: "cli", c, dir: dirname(path) };
    return { kind: null };
  }
  function identity(p: Picked): AccountIdentity {
    if (p.kind === null) return { accountKind: null, plan: null, fingerprint: null };
    const files = [join(p.dir, ".claude.json")];
    if (p.kind === "cli" && opts.path === undefined) files.push(join(homedir(), ".claude.json"));
    const id = identityFrom(files);
    return { accountKind: p.kind, plan: p.c.plan, fingerprint: `${p.kind}:${id ? sha(id) : `plan-${p.c.plan ?? "unknown"}`}` };
  }

  const request = (token: string): Promise<Response> =>
    fetchFn(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json", "user-agent": "usage-meter-desktop/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
  const expired = (c: { expiresAt: number | null }) => c.expiresAt !== null && c.expiresAt < now();

  return {
    path,
    inspect: () => identity(pick()),
    stamp: () => `${trayPath ? mtimeOf(trayPath) : 0}|${mtimeOf(path)}`,
    async poll() {
      let p = pick();
      if (p.kind === null) {
        if (readCredentials(path).status === "invalid") return { kind: "error", note: NOTE_REFRESH, plan: null };
        return { kind: "none", note: NOTE_SIGN_IN };
      }
      const kind = p.kind;
      const signInNote = kind === "tray" ? NOTE_TRAY_SIGN_IN : NOTE_REFRESH;
      let id = identity(p);
      const err = (note: string, extra: { httpStatus?: number; retryAfterMs?: number } = {}): AccountPoll => ({ kind: "error", note, plan: id.plan, accountKind: kind, fingerprint: id.fingerprint, ...extra });
      if (expired(p.c)) {
        if (kind !== "tray") return err(signInNote);
        await silentRefresh();
        p = pick();
        if (p.kind !== "tray" || expired(p.c)) return err(signInNote);
        id = identity(p);
      }

      let triedRefresh = false;
      for (;;) {
        const token = p.kind === null ? "" : p.c.token;
        try {
          const res = await request(token);
          if (res.status === 401 || res.status === 403) {
            if (kind === "tray" && !triedRefresh) {
              triedRefresh = true;
              await silentRefresh();
              p = pick();
              if (p.kind === "tray" && p.c.token !== token) {
                id = identity(p);
                continue;
              }
            }
            return err(signInNote);
          }
          if (!res.ok) {
            const ra = parseRetryAfter(res.headers?.get?.("retry-after"), now());
            return err(res.status === 429 ? NOTE_RATE_LIMIT : noteHttp(res.status), { httpStatus: res.status, ...(ra !== null ? { retryAfterMs: ra } : {}) });
          }
          const usage = parseAccountUsage(await res.json().catch(() => null), now());
          if (!usage) return err(NOTE_OFFLINE, { httpStatus: res.status });
          return { kind: "ok", usage, plan: id.plan, accountKind: kind, fingerprint: id.fingerprint };
        } catch {
          return err(NOTE_OFFLINE);
        }
      }
    },
  };
}
