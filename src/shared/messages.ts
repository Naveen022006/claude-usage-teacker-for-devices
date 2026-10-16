// Message contracts between the extension's contexts.
//
//   inject.ts (MAIN) --window.postMessage(PageMessage)--> bridge.ts (ISOLATED)
//   bridge.ts --chrome.runtime.sendMessage(PageMessage)--> sw.ts
//   popup/options --chrome.runtime.sendMessage(UiRequest)--> sw.ts (responds via sendResponse)

import type {
  Aggregates,
  AccountUsage,
  CaptureDiag,
  SwDiag,
  Source,
  CapturedEvent,
  DeviceInfo,
  LimitHint,
  Plan,
  Settings,
  SyncState,
} from "./types";

export const NS = "claude-usage" as const;

/** Messages originating in the page (MAIN world). Every field is re-validated by the SW. */
export type PageMessage =
  | { ns: typeof NS; type: "usage-event"; payload: CapturedEvent }
  | { ns: typeof NS; type: "org-seen"; payload: { orgId: string } }
  | { ns: typeof NS; type: "limit-hint"; payload: LimitHint }
  | { ns: typeof NS; type: "diag"; payload: CaptureDiag };

/**
 * Requests from the claude.ai widget content script (sender.tab on https://claude.ai/ only).
 * These are the ONLY content-script messages that get a response. Wrapped with `ns` like PageMessage.
 */
export type WidgetRequest =
  | { ns: typeof NS; type: "get-widget-state"; orgHint?: string }
  | { ns: typeof NS; type: "open-options" };

/** SW -> widget broadcast (chrome.tabs.sendMessage) after a new usage event / account refresh. */
export interface StateChangedMessage {
  ns: typeof NS;
  type: "state-changed";
}

/** One device as reported by the hub's GET /api/state, stripped to what the widget needs. */
export interface HubDevice {
  deviceId: string;
  deviceName: string;
  source: Source;
  estimated: boolean;
  receivedAt: number;
  fresh: boolean;
  windows: Aggregates;
}

export interface HubStateResult {
  ok: boolean;
  error?: string;
  fetchedAt: number;
  devices: HubDevice[];
}

export interface WidgetState {
  device: DeviceInfo;
  aggregates: Aggregates;
  accountUsage: AccountUsage | null;
  /** Subscription plan once learned (null = unknown). */
  plan: Plan | null;
  /** Latest message_limit hint seen in a completion stream (Free accounts have no usage endpoint). */
  limitHint: LimitHint | null;
  syncState: SyncState;
  showWidget: boolean;
  codeDeviceIds: string[];
  hub: { configured: boolean; ok: boolean; error?: string; fetchedAt: number; devices: HubDevice[] };
  now: number;
  /** Capture diagnostics (counters + redacted path patterns / event-type names only). */
  captureDiag: CaptureDiag | null;
  swDiag: SwDiag;
}

/** Requests from popup / options to the service worker. */
export type UiRequest =
  | { type: "get-state" }
  | { type: "save-settings"; settings: Partial<Settings>; deviceName?: string }
  | { type: "get-hub-devices" }
  | { type: "test-connection" }
  | { type: "sync-now" }
  | { type: "get-diag" }
  | { type: "reset-diag" }
  | { type: "export-data" }
  | { type: "clear-data" };

export interface UiState {
  device: DeviceInfo;
  settings: Settings;
  syncState: SyncState;
  accountUsage: AccountUsage | null;
  aggregates: Aggregates;
  eventCount: number;
}

/** Response map for each UiRequest type. All responses use this envelope. */
export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface UiResponseData {
  "get-state": UiState;
  "save-settings": UiState;
  "get-hub-devices": WidgetState["hub"];
  "test-connection": { reachable: boolean; detail: string };
  "sync-now": SyncState;
  "get-diag": { page: CaptureDiag | null; sw: SwDiag };
  "reset-diag": { page: CaptureDiag | null; sw: SwDiag };
  "export-data": { json: string };
  "clear-data": UiState;
}

/** Typed helper for UI → SW calls. */
export async function callSw<K extends UiRequest["type"]>(
  req: Extract<UiRequest, { type: K }>,
): Promise<UiResponse<UiResponseData[K]>> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResponseData[K]> | undefined;
    return res ?? { ok: false, error: "no response from service worker" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
