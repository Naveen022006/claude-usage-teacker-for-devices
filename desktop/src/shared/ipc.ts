// Contract between the companion's main process and its renderer (via preload `window.usageMeter`).
// Phase "desktop": Claude Desktop is a hardened MSIX/Electron app (no inspect, asar integrity, encrypted
// cookies), so we do NOT inject into it. This companion is a separate small always-on-top window that shows
// the same panel as the Chrome extension, from (a) its own claude.ai login session → /usage plan limits, and
// (b) local Claude Code / Claude Desktop Code-session transcripts (exact tokens, reused daemon scanner).
// Never read or keep message content — only ids, models, timestamps and token counts.

import type { AccountUsage, Aggregates, Plan } from "../../../src/shared/types";
import type { AttributionView } from "../../../src/shared/attribution";

export type AuthState = "signed-out" | "signing-in" | "signed-in" | "error";

export interface LocalSourceUsage {
  /** "claude-code" = terminal / VS Code; "desktop" = Claude Desktop Code sessions (transcript entrypoint). */
  source: "claude-code" | "desktop";
  aggregates: Aggregates; // today / last5h / last7d, exact tokens
}

export interface DesktopState {
  now: number;
  auth: { state: AuthState; error?: string };
  plan: Plan | null;
  /** Latest plan-limit reading from claude.ai /usage (null when signed out / Free / unavailable). */
  accountUsage: AccountUsage | null;
  /** Per-model percentage points of the 5h and weekly windows (estimates; see src/shared/attribution.ts). */
  attribution: AttributionView;
  /** Local transcript usage, one entry per source that has events. */
  local: LocalSourceUsage[];
  /** Combined local byModel tokens in the last 5 h (for the Tokens column). */
  tokens5hByModel: Record<string, number>;
  scan: { lastScanAt: number | null; filesRead: number; error?: string };
  ui: { alwaysOnTop: boolean; collapsed: boolean };
}

/** Renderer → main requests (ipcRenderer.invoke). */
export type DesktopRequest =
  | { type: "get-state" }
  | { type: "sign-in" } // opens the claude.ai login window
  | { type: "sign-out" }
  | { type: "refresh" } // immediate usage + scan
  | { type: "set-ui"; ui: Partial<DesktopState["ui"]> }
  | { type: "reset-attribution" }
  | { type: "auth-status" } // -> { accountKind, plan, signedIn } (no secrets)
  | { type: "quit" };

/** Main → renderer push channel name; payload is DesktopState. */
export const STATE_CHANNEL = "usage-meter:state";
export const REQUEST_CHANNEL = "usage-meter:request";

/** Exposed by preload as `window.usageMeter`. */
export interface UsageMeterBridge {
  request<T = unknown>(req: DesktopRequest): Promise<T>;
  onState(cb: (s: DesktopState) => void): () => void;
}
