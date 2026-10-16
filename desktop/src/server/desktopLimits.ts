// Plan-limit sources for the Claude account used in Claude DESKTOP. Claude Desktop never exposes its sign-in
// (its Code sessions run with host-managed auth), so we never read credentials. Two read-only inputs:
//   1. Chrome extension → POST 127.0.0.1/api/local-account: the extension, signed in to claude.ai with the same
//      account, sends the plan %, reset times, plan name and org id it reads from claude.ai. Several Chrome
//      profiles (Free / Pro / Max) may report; we use the highest plan, newest reading first.
//   2. desktop-limits.json from the Claude Code statusLine (only if Claude Desktop ever runs it).
// The user's Claude Code CLI is a different account and is never used.

import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsage, Plan } from "../../../src/shared/types";
import type { AccountIdentity, AccountPoll, AccountSource } from "./accountUsage";

export const LIMITS_FILE = "desktop-limits.json";
export const CHROME_FILE = "chrome-accounts.json";
export const NOTE_WAITING = "Waiting for plan usage — open Chrome with the Usage Meter extension signed in to your Claude Desktop account";
/** A Chrome reading older than this is not used (the extension pushes every minute while Chrome runs). */
export const CHROME_MAX_AGE_MS = 6 * 3600_000;

const PLAN_RANK: Record<string, number> = { max: 4, team: 3, pro: 2, free: 1 };
const ORG_RE = /^[A-Za-z0-9-]{1,64}$/;

function mtimeOf(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

function parseUsage(x: unknown): AccountUsage | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.fetchedAt !== "number" || !Number.isFinite(o.fetchedAt) || !Array.isArray(o.windows)) return null;
  const windows: AccountUsage["windows"] = [];
  for (const w of o.windows.slice(0, 8) as Record<string, unknown>[]) {
    if (!w || typeof w.name !== "string" || w.name.length > 40) continue;
    if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    windows.push({
      name: w.name,
      utilization: Math.min(100, Math.max(0, w.utilization)),
      ...(typeof w.resetsAt === "string" && w.resetsAt.length <= 40 ? { resetsAt: w.resetsAt } : {}),
    });
  }
  return windows.length ? { fetchedAt: o.fetchedAt, windows } : null;
}

/** Parses desktop-limits.json (statusLine output) into AccountUsage; null when missing or malformed. */
export function readDesktopLimits(file: string): AccountUsage | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (j.v !== 1) return null;
    return parseUsage(j);
  } catch {
    return null;
  }
}

export interface ChromeAccount {
  orgId: string;
  plan: Plan | null;
  usage: AccountUsage;
  receivedAt: number;
}

/** Latest reading per Claude org reported by the Chrome extension(s); persisted so restarts keep it. */
export class ChromeAccounts {
  private byOrg = new Map<string, ChromeAccount>();
  constructor(private file: string | null) {
    if (!file) return;
    try {
      const arr = JSON.parse(readFileSync(file, "utf8")) as unknown[];
      for (const a of arr) {
        const r = ChromeAccounts.parse(a, (a as ChromeAccount)?.receivedAt ?? 0);
        if (r) this.byOrg.set(r.orgId, r);
      }
    } catch {
      /* first run */
    }
  }

  static parse(body: unknown, now: number): ChromeAccount | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (typeof b.orgId !== "string" || !ORG_RE.test(b.orgId)) return null;
    const usage = parseUsage(b.usage);
    if (!usage) return null;
    const plan = typeof b.plan === "string" && b.plan in PLAN_RANK ? (b.plan as Plan) : null;
    return { orgId: b.orgId, plan, usage, receivedAt: now };
  }

  /** Validates and stores a report; false when invalid. Older readings for the same org are ignored. */
  accept(body: unknown, now: number): boolean {
    const r = ChromeAccounts.parse(body, now);
    if (!r) return false;
    const prev = this.byOrg.get(r.orgId);
    if (prev && prev.usage.fetchedAt > r.usage.fetchedAt) return true;
    this.byOrg.set(r.orgId, r);
    this.save();
    return true;
  }

  /** Highest plan among recent reports; ties → newest reading. */
  best(now: number): ChromeAccount | null {
    let best: ChromeAccount | null = null;
    for (const a of this.byOrg.values()) {
      if (now - a.receivedAt > CHROME_MAX_AGE_MS) continue;
      const rank = (x: ChromeAccount) => PLAN_RANK[x.plan ?? ""] ?? 0;
      if (!best || rank(a) > rank(best) || (rank(a) === rank(best) && a.usage.fetchedAt > best.usage.fetchedAt)) best = a;
    }
    return best;
  }

  private save(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.byOrg.values()]));
      renameSync(tmp, this.file);
    } catch {
      /* ignore */
    }
  }
}

const orgFp = (orgId: string) => "org:" + createHash("sha256").update(orgId).digest("hex").slice(0, 16);

export function createDesktopLimitsSource(opts: { dataDir: string; chrome?: ChromeAccounts; now?: () => number }): AccountSource {
  const path = join(opts.dataDir, LIMITS_FILE);
  const chrome = opts.chrome ?? new ChromeAccounts(null);
  const now = opts.now ?? Date.now;
  let identity: AccountIdentity = { accountKind: "desktop", plan: null, fingerprint: null };
  return {
    path,
    inspect: () => identity,
    stamp: () => String(mtimeOf(path)),
    async poll(): Promise<AccountPoll> {
      const t = now();
      const fromChrome = chrome.best(t);
      const fromStatus = readDesktopLimits(path);
      // Prefer whichever reading is newer; the statusLine one carries no plan/org, so keep Chrome's identity.
      if (fromChrome && (!fromStatus || fromChrome.usage.fetchedAt >= fromStatus.fetchedAt)) {
        identity = { accountKind: "desktop", plan: fromChrome.plan, fingerprint: orgFp(fromChrome.orgId) };
        return { kind: "ok", usage: fromChrome.usage, plan: fromChrome.plan, accountKind: "desktop", fingerprint: identity.fingerprint };
      }
      if (fromStatus) {
        identity = { accountKind: "desktop", plan: identity.plan, fingerprint: identity.fingerprint ?? "claude-desktop" };
        return { kind: "ok", usage: fromStatus, plan: identity.plan, accountKind: "desktop", fingerprint: identity.fingerprint };
      }
      return { kind: "none", note: NOTE_WAITING };
    },
  };
}
