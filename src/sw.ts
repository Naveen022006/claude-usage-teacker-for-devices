// Background service worker. Listeners are registered at top level (MV3 requirement);
// the SW may be killed at any time, which is fine because every report is a full snapshot.

import { clampCharsPerToken, estimateTokens } from "./capture/tokens";
import { computeAggregates, pruneEvents } from "./shared/aggregate";
import {
  NS,
  type HubStateResult,
  type PageMessage,
  type UiRequest,
  type UiResponse,
  type UiResponseData,
  type UiState,
  type WidgetState,
} from "./shared/messages";
import { DEFAULT_SYNC_STATE, type Settings, type SyncState, type UsageEvent } from "./shared/types";
import { validatePageMessage, validateWidgetRequest } from "./shared/validate";
import * as store from "./storage";
import { fetchAccountUsage } from "./sync/accountUsage";
import { buildReport, fetchHubState, normalizeBase, ping, sendReport } from "./sync/hub";

const HEARTBEAT = "heartbeat";
const SYNC_DEBOUNCE_MS = 3000;
const USAGE_POLL_MS = 5 * 60_000;

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let lastUsageAttempt = 0;

async function setup(): Promise<void> {
  await store.ensureDevice();
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== HEARTBEAT) return;
  void heartbeat();
});

async function heartbeat(): Promise<void> {
  try {
    await pollAccountUsage();
  } catch (e) {
    console.warn("[claude-usage] usage poll failed", e);
  }
  await syncNow();
}

async function pollAccountUsage(): Promise<void> {
  const [settings, orgId, current] = await Promise.all([
    store.get("settings"),
    store.get("orgId"),
    store.get("accountUsage"),
  ]);
  if (!settings.pollAccountUsage || !orgId) return;
  const now = Date.now();
  if (now - Math.max(current?.fetchedAt ?? 0, lastUsageAttempt) < USAGE_POLL_MS) return;
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (!tabs.length) return;
  lastUsageAttempt = now;
  const usage = await fetchAccountUsage(orgId);
  if (usage) await store.set({ accountUsage: usage });
}

// ---- messages ----

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.tab) {
    if (sender.url?.startsWith("https://claude.ai/") && sender.id === chrome.runtime.id) {
      // The widget (ISOLATED content script) is the only content script that gets a response.
      const w = validateWidgetRequest(msg);
      if (w) {
        handleWidget(w.type).then(sendResponse, (e) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return true;
      }
      const m = validatePageMessage(msg);
      if (m) void handlePage(m).catch((e) => console.warn("[claude-usage] page message failed", e));
    }
    return false;
  }
  if (sender.id !== chrome.runtime.id) return false;
  handleUi(msg as UiRequest).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});

async function handlePage(m: PageMessage): Promise<void> {
  switch (m.type) {
    case "usage-event": {
      const [device, settings] = await Promise.all([store.ensureDevice(), store.get("settings")]);
      const c = m.payload;
      const cpt = settings.charsPerToken;
      const ev: UsageEvent = {
        id: c.id,
        ts: c.ts,
        source: "chrome",
        deviceId: device.deviceId,
        model: c.model,
        promptChars: c.promptChars,
        outputChars: c.outputChars,
        thinkingChars: c.thinkingChars,
        promptTokens: estimateTokens(c.promptChars, cpt),
        outputTokens: estimateTokens(c.outputChars + c.thinkingChars, cpt),
        estimated: true,
        status: c.status,
        kind: c.kind,
      };
      let isNew = true;
      await store.mutateEvents((events) => {
        const i = events.findIndex((e) => e.id === ev.id);
        const next = events.slice();
        if (i >= 0) {
          isNew = false;
          next[i] = ev; // retry/duplicate post with the same id replaces
        } else next.push(ev);
        return pruneEvents(next, Date.now());
      });
      if (isNew) {
        const s = await store.get("syncState");
        await store.set({ syncState: { ...s, queue: s.queue + 1 } });
      }
      scheduleSync();
      void broadcastStateChanged();
      return;
    }
    case "org-seen":
      await store.set({ orgId: m.payload.orgId });
      return;
    case "limit-hint":
      await store.set({ limitHint: m.payload });
      return;
  }
}

/** Tells open claude.ai tabs (the widget) to refresh. Fire-and-forget. */
async function broadcastStateChanged(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    for (const t of tabs) {
      if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { ns: NS, type: "state-changed" }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// ---- widget ----

const HUB_CACHE_MS = 30_000;
const WIDGET_USAGE_STALE_MS = 2 * 60_000;
const WIDGET_USAGE_MIN_GAP_MS = 60_000;
let hubCache: { key: string; at: number; result: HubStateResult } | null = null;
let lastWidgetUsageAttempt = 0;

async function getHubState(settings: Settings): Promise<WidgetState["hub"]> {
  const none = { configured: false, ok: false, fetchedAt: 0, devices: [] };
  if (!settings.hubUrl.trim()) return none;
  const pattern = hostPattern(settings.hubUrl);
  if (!pattern) return { ...none, configured: true, error: "Invalid Hub URL" };
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ...none, configured: true, error: `Host permission not granted for ${pattern}` };
  }
  const key = normalizeBase(settings.hubUrl) + "\n" + settings.hubToken;
  const now = Date.now();
  if (!hubCache || hubCache.key !== key || now - hubCache.at > HUB_CACHE_MS) {
    const result = await fetchHubState(settings.hubUrl, settings.hubToken);
    hubCache = { key, at: now, result };
  }
  const r = hubCache.result;
  return { configured: true, ok: r.ok, error: r.error, fetchedAt: r.fetchedAt, devices: r.devices };
}

/** Refresh account usage in the background when the widget asks and it is stale. */
function maybeRefreshUsageForWidget(settings: Settings, orgId: string | null, usage: WidgetState["accountUsage"]): void {
  const now = Date.now();
  if (!settings.pollAccountUsage || !orgId) return;
  if (now - (usage?.fetchedAt ?? 0) < WIDGET_USAGE_STALE_MS) return;
  if (now - lastWidgetUsageAttempt < WIDGET_USAGE_MIN_GAP_MS) return;
  lastUsageAttempt = lastWidgetUsageAttempt = now;
  void fetchAccountUsage(orgId)
    .then(async (u) => {
      if (u) {
        await store.set({ accountUsage: u });
        void broadcastStateChanged();
      }
    })
    .catch((e) => console.warn("[claude-usage] widget usage refresh failed", e));
}

async function handleWidget(type: "get-widget-state" | "open-options"): Promise<UiResponse> {
  try {
    if (type === "open-options") {
      await chrome.runtime.openOptionsPage();
      return { ok: true, data: null };
    }
    const [device, settings, syncState, accountUsage, events, orgId] = await Promise.all([
      store.ensureDevice(),
      store.get("settings"),
      store.get("syncState"),
      store.get("accountUsage"),
      store.get("events"),
      store.get("orgId"),
    ]);
    maybeRefreshUsageForWidget(settings, orgId, accountUsage);
    const now = Date.now();
    const state: WidgetState = {
      device,
      aggregates: computeAggregates(events, now),
      accountUsage,
      syncState,
      showWidget: settings.showWidget,
      hub: await getHubState(settings),
      now,
    };
    return { ok: true, data: state };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function scheduleSync(): void {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncNow(), SYNC_DEBOUNCE_MS);
}

// ---- sync ----

function hostPattern(url: string): string | null {
  try {
    const u = new URL(normalizeBase(url));
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function patchSync(patch: Partial<SyncState>): Promise<SyncState> {
  const next = { ...(await store.get("syncState")), ...patch };
  await store.set({ syncState: next });
  return next;
}

let syncing: Promise<SyncState> | null = null;
function syncNow(): Promise<SyncState> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync(): Promise<SyncState> {
  const settings = await store.get("settings");
  if (!settings.syncEnabled) return store.get("syncState");
  const attemptAt = Date.now();
  try {
    const pattern = hostPattern(settings.hubUrl);
    if (!pattern) return await patchSync({ lastAttemptAt: attemptAt, lastError: "Invalid Hub URL" });
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
      return await patchSync({ lastAttemptAt: attemptAt, lastError: `Host permission not granted for ${pattern}` });
    }
    const [device, events, account] = await Promise.all([
      store.ensureDevice(),
      store.get("events"),
      store.get("accountUsage"),
    ]);
    const res = await sendReport(settings.hubUrl, settings.hubToken, buildReport(device, events, account));
    return await patchSync(
      res.ok
        ? { lastAttemptAt: attemptAt, lastOkAt: Date.now(), lastError: null, queue: 0 }
        : { lastAttemptAt: attemptAt, lastError: res.error ?? "Unknown error" },
    );
  } catch (e) {
    return patchSync({ lastAttemptAt: attemptAt, lastError: e instanceof Error ? e.message : String(e) });
  }
}

// ---- UI requests ----

async function buildState(): Promise<UiState> {
  const [device, settings, syncState, accountUsage, events] = await Promise.all([
    store.ensureDevice(),
    store.get("settings"),
    store.get("syncState"),
    store.get("accountUsage"),
    store.get("events"),
  ]);
  return {
    device,
    settings,
    syncState,
    accountUsage,
    aggregates: computeAggregates(events, Date.now()),
    eventCount: events.length,
  };
}

function ok<K extends UiRequest["type"]>(data: UiResponseData[K]): UiResponse<UiResponseData[K]> {
  return { ok: true, data };
}

async function handleUi(req: UiRequest): Promise<UiResponse> {
  try {
    switch (req?.type) {
      case "get-state":
        return ok<"get-state">(await buildState());
      case "save-settings": {
        const cur = await store.get("settings");
        const p = req.settings ?? {};
        const next: Settings = { ...cur };
        if (typeof p.hubUrl === "string") next.hubUrl = p.hubUrl.trim().slice(0, 200);
        if (typeof p.syncEnabled === "boolean") next.syncEnabled = p.syncEnabled;
        if (p.charsPerToken !== undefined) next.charsPerToken = clampCharsPerToken(p.charsPerToken);
        if (typeof p.hubToken === "string") next.hubToken = p.hubToken.slice(0, 200);
        if (typeof p.pollAccountUsage === "boolean") next.pollAccountUsage = p.pollAccountUsage;
        if (typeof p.showWidget === "boolean") next.showWidget = p.showWidget;
        await store.set({ settings: next });
        if (typeof req.deviceName === "string") {
          const name = req.deviceName.trim().slice(0, 40);
          if (name) await store.set({ device: { ...(await store.ensureDevice()), deviceName: name } });
        }
        if (next.syncEnabled) scheduleSync();
        return ok<"save-settings">(await buildState());
      }
      case "test-connection": {
        const s = await store.get("settings");
        const pattern = hostPattern(s.hubUrl);
        if (!pattern) return ok<"test-connection">({ reachable: false, detail: "Invalid Hub URL" });
        if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
          return ok<"test-connection">({ reachable: false, detail: `Host permission not granted for ${pattern}` });
        }
        const r = await ping(s.hubUrl, s.hubToken);
        return ok<"test-connection">({ reachable: r.ok, detail: r.ok ? "OK" : (r.error ?? "Unreachable") });
      }
      case "sync-now": {
        clearTimeout(syncTimer);
        return ok<"sync-now">(await syncNow());
      }
      case "export-data": {
        const [device, settings, events, accountUsage] = await Promise.all([
          store.ensureDevice(),
          store.get("settings"),
          store.get("events"),
          store.get("accountUsage"),
        ]);
        const { hubToken: _omit, ...safeSettings } = settings;
        return ok<"export-data">({ json: JSON.stringify({ device, settings: safeSettings, events, accountUsage }, null, 2) });
      }
      case "clear-data": {
        await store.mutateEvents(() => []);
        await store.set({ accountUsage: null, limitHint: null, syncState: { ...DEFAULT_SYNC_STATE } });
        return ok<"clear-data">(await buildState());
      }
      default:
        return { ok: false, error: "unknown request" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
