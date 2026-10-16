// Shared data model — see docs/03-data-model.md and docs/04-device-sync.md.
// Nothing in here may ever hold message text.

import type { Ledger } from "./attribution";

export type Source = "chrome" | "claude-code" | "desktop";
export type EventStatus = "ok" | "error" | "aborted";
export type EventKind = "new" | "retry";

/** One per completed reply. */
export interface UsageEvent {
  id: string; // message id from stream, else uuid
  ts: number; // epoch ms when stream finished
  source: Source;
  deviceId: string;
  model: string; // e.g. "claude-sonnet-5-5" or "unknown"
  promptChars: number;
  outputChars: number;
  thinkingChars: number;
  promptTokens: number; // estimated
  outputTokens: number; // estimated (includes thinking)
  estimated: boolean;
  status: EventStatus;
  kind: EventKind;
  // Exact sources only (Claude Code). promptTokens already includes these; kept for detail views.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * What the MAIN-world capture layer produces. The service worker adds
 * deviceId/source/estimated and computes tokens using settings.charsPerToken.
 */
export interface CapturedEvent {
  id: string;
  ts: number;
  model: string;
  promptChars: number;
  outputChars: number;
  thinkingChars: number;
  status: EventStatus;
  kind: EventKind;
}

export interface AccountWindow {
  name: string; // e.g. "five_hour", "seven_day"
  utilization: number; // 0–100
  resetsAt?: string; // ISO string
}

export interface AccountUsage {
  fetchedAt: number;
  windows: AccountWindow[];
}

/** Claude subscription plan, derived from /api/organizations capabilities. */
export type Plan = "free" | "pro" | "max" | "team";

/** Caps for LimitHint.fields (shared by the parser and the SW-side validator). */
export const HINT_MAX_KEYS = 48;
export const HINT_MAX_KEY_LEN = 80;
export const HINT_MAX_STR = 64;
export const HINT_MAX_DEPTH = 3;

/** Rate-limit info seen inside a completion stream (shape undocumented → dotted keys, primitives only, up to 3 levels deep). */
export interface LimitHint {
  ts: number;
  fields: Record<string, string | number | boolean>;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
}

export interface Settings {
  hubUrl: string; // e.g. "https://my-hub.vercel.app"; "" = not configured
  syncEnabled: boolean;
  charsPerToken: number; // 2.5–5, default 3.6
  hubToken: string; // sent as "Authorization: Bearer <token>" when non-empty
  pollAccountUsage: boolean;
  showWidget: boolean; // in-page widget on claude.ai
  codeDeviceIds: string[]; // hub devices counted as "Claude Code on this computer"; [] = auto (all claude-code/desktop)
}

export const DEFAULT_SETTINGS: Settings = {
  hubUrl: "",
  syncEnabled: false,
  charsPerToken: 3.6,
  hubToken: "",
  pollAccountUsage: true,
  showWidget: true,
  codeDeviceIds: [],
};

export interface SyncState {
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  queue: number; // events recorded since last successful sync
}

export const DEFAULT_SYNC_STATE: SyncState = {
  lastOkAt: null,
  lastAttemptAt: null,
  lastError: null,
  queue: 0,
};

export interface ModelAggregate {
  messages: number;
  tokens: number; // promptTokens + outputTokens
}

export interface WindowAggregate {
  messages: number;
  promptTokens: number;
  outputTokens: number;
  byModel: Record<string, ModelAggregate>;
}

export type WindowName = "today" | "last5h" | "last7d";
export type Aggregates = Record<WindowName, WindowAggregate>;

/** chrome.storage.local layout. */
export interface StorageShape {
  device: DeviceInfo;
  events: UsageEvent[];
  accountUsage: AccountUsage | null;
  limitHint: LimitHint | null;
  orgId: string | null; // learned from captured completion URLs
  plan: Plan | null; // learned from /api/organizations
  settings: Settings;
  syncState: SyncState;
  captureDiag: CaptureDiag | null;
  swDiag: SwDiag;
  usageDiag: UsageDiag | null;
  limitLedger: Ledger;
}

/** POST /api/report body — docs/04-device-sync.md. Keep `v` versioned. */
export interface Report {
  v: 1;
  deviceId: string;
  deviceName: string;
  source: Source;
  sentAt: number;
  windows: Aggregates;
  estimated: boolean;
  account: AccountUsage | null;
}

/** One observed same-origin /api/ response (diagnostics only; no message content). */
export interface DiagObservation {
  at: number;
  pathPattern: string;
  contentType: string;
  status: number;
  matchedRegex: boolean;
  eventTypes: string[];
  recorded: boolean;
  reason?: string;
}

/** Posted by the MAIN-world hook, stored by the SW as `captureDiag`. */
export interface CaptureDiag {
  updatedAt: number;
  hookInstalled: boolean;
  fetchCalls: number;
  streamsSeen: number;
  emptyStreams: number;
  eventsPosted: number;
  observations: DiagObservation[];
}

/** Service-worker-side counters, stored as `swDiag`. */
export interface SwDiag {
  eventsReceived: number;
  eventsRejected: number;
  lastRejectReason: string | null;
  eventsStored: number;
}

export const DEFAULT_SW_DIAG: SwDiag = { eventsReceived: 0, eventsRejected: 0, lastRejectReason: null, eventsStored: 0 };

/** Shape (never values) of the last /usage response, stored as `usageDiag`. */
export interface UsageDiag {
  at: number;
  status: number | null; // HTTP status, null = network/JSON error
  shape: Record<string, string | Record<string, string>>;
  parsed: boolean;
}
