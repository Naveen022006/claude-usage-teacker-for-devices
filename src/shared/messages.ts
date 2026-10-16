// Message contracts between the extension's contexts.
//
//   inject.ts (MAIN) --window.postMessage(PageMessage)--> bridge.ts (ISOLATED)
//   bridge.ts --chrome.runtime.sendMessage(PageMessage)--> sw.ts
//   popup/options --chrome.runtime.sendMessage(UiRequest)--> sw.ts (responds via sendResponse)

import type {
  Aggregates,
  AccountUsage,
  CapturedEvent,
  DeviceInfo,
  LimitHint,
  Settings,
  SyncState,
} from "./types";

export const NS = "deskbuddy" as const;

/** Messages originating in the page (MAIN world). Every field is re-validated by the SW. */
export type PageMessage =
  | { ns: typeof NS; type: "usage-event"; payload: CapturedEvent }
  | { ns: typeof NS; type: "org-seen"; payload: { orgId: string } }
  | { ns: typeof NS; type: "limit-hint"; payload: LimitHint };

/** Requests from popup / options to the service worker. */
export type UiRequest =
  | { type: "get-state" }
  | { type: "save-settings"; settings: Partial<Settings>; deviceName?: string }
  | { type: "test-connection" }
  | { type: "sync-now" }
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
  "test-connection": { reachable: boolean; detail: string };
  "sync-now": SyncState;
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
