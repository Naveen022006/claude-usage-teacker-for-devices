// Shared types for plan-limit sources. The only source now is Claude Desktop (see desktopLimits.ts):
// the user's Claude Code CLI is a different account, so no CLI credentials, separate login or
// Anthropic API calls are used anymore.

import type { AccountUsage, Plan } from "../../../src/shared/types";

export type AccountKind = "tray" | "cli" | "desktop";

/** Kept for TrayState compatibility; only shown if a non-Desktop source were ever used. */
export const NOTE_CLI = "Showing Claude Code CLI account — not Claude Desktop";
export const NOTE_REFRESH = "Plan limits need a refresh";
export const NOTE_TRAY_SIGN_IN = NOTE_REFRESH;

export type RefreshSpawn = (configDir: string) => Promise<void>;

export interface AccountIdentity {
  accountKind: AccountKind | null;
  plan: Plan | null;
  /** Identity of the account the readings belong to (not a secret). */
  fingerprint: string | null;
}

export type AccountPoll =
  | { kind: "ok"; usage: AccountUsage; plan: Plan | null; accountKind: AccountKind; fingerprint: string | null }
  | { kind: "none"; note: string }
  | { kind: "error"; note: string; plan: Plan | null; accountKind?: AccountKind; fingerprint?: string | null; httpStatus?: number; retryAfterMs?: number };

export interface AccountSource {
  poll(): Promise<AccountPoll>;
  path: string;
  inspect(): AccountIdentity;
  /** Changes whenever the underlying data changes (cheap, no I/O beyond stat). */
  stamp(): string;
}
