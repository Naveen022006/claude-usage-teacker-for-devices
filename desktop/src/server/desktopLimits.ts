// Plan-limit source = Claude DESKTOP only. The statusLine command (src/statusline/statusline.ts), run by
// Claude Code inside Claude Desktop's Code tab, writes desktop-limits.json with the Session/Weekly % that
// Anthropic reports for the Desktop account. Claude Code CLI sessions (a different account for this user)
// are ignored by that script, and no credentials are read anywhere. Read-only, no network.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsage } from "../../../src/shared/types";
import type { AccountIdentity, AccountPoll, AccountSource } from "./accountUsage";

export const LIMITS_FILE = "desktop-limits.json";
export const NOTE_WAITING = "Waiting for Claude Desktop — send a message in its Code tab";

interface Opts {
  dataDir: string;
}

function mtimeOf(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** Parses desktop-limits.json into AccountUsage; null when missing or malformed. */
export function readDesktopLimits(file: string): AccountUsage | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (j.v !== 1 || typeof j.fetchedAt !== "number" || !Array.isArray(j.windows)) return null;
    const windows: AccountUsage["windows"] = [];
    for (const w of j.windows as Record<string, unknown>[]) {
      if (!w || (w.name !== "five_hour" && w.name !== "seven_day")) continue;
      if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
      windows.push({
        name: w.name,
        utilization: Math.min(100, Math.max(0, w.utilization)),
        ...(typeof w.resetsAt === "string" ? { resetsAt: w.resetsAt } : {}),
      });
    }
    return windows.length ? { fetchedAt: j.fetchedAt, windows } : null;
  } catch {
    return null;
  }
}

export function createDesktopLimitsSource(opts: Opts): AccountSource {
  const path = join(opts.dataDir, LIMITS_FILE);
  // Plan isn't in the statusLine JSON; rate limits are only sent to Pro/Max accounts, so leave it unknown.
  const identity: AccountIdentity = { accountKind: "desktop", plan: null, fingerprint: "claude-desktop" };
  return {
    path,
    inspect: () => identity,
    stamp: () => String(mtimeOf(path)),
    async poll(): Promise<AccountPoll> {
      const usage = readDesktopLimits(path);
      if (!usage) return { kind: "none", note: NOTE_WAITING };
      return { kind: "ok", usage, plan: null, accountKind: "desktop", fingerprint: identity.fingerprint };
    },
  };
}
