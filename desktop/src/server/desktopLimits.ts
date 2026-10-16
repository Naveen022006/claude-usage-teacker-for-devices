// Plan limits (Session 5h % / Weekly %) for the Claude Desktop account.
//
// Claude Desktop is the ONLY allowed source (the user's Claude Code CLI is another account, and Chrome is not to
// be used). Verified 2026-10-16: Claude Desktop does not expose its plan limits anywhere readable — its Code
// sessions run in simple mode with host-managed auth (no statusLine, no token), its logs contain no usage fields,
// and its transcripts only carry `rateLimits: null`. Its sign-in is encrypted and is deliberately never read.
// So this source reports "not available" with a clear note; per-model usage still comes, exactly, from the
// Claude Desktop Code-session transcripts (engine.ts).

import type { AccountIdentity, AccountPoll, AccountSource } from "./accountUsage";

export const NOTE_DESKTOP_NO_LIMITS = "Claude Desktop doesn't share its plan limits — showing your exact Claude Desktop usage";

export function createDesktopLimitsSource(): AccountSource {
  const identity: AccountIdentity = { accountKind: "desktop", plan: null, fingerprint: "claude-desktop" };
  return {
    path: "",
    inspect: () => identity,
    stamp: () => "",
    async poll(): Promise<AccountPoll> {
      return { kind: "none", note: NOTE_DESKTOP_NO_LIMITS };
    },
  };
}
