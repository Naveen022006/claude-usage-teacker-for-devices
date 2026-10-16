// Shared data model — see docs/03-data-model.md and docs/04-device-sync.md.
// Nothing in here may ever hold message text.

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

/** Rate-limit info seen inside a completion stream (shape undocumented → flat primitives only). */
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
  settings: Settings;
  syncState: SyncState;
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
