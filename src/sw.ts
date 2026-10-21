// Background service worker. Listeners are registered at top level (MV3 requirement);
// the SW may be killed at any time, which is fine because every report is a full snapshot.

import { clampCharsPerToken, estimateTokens } from "./capture/tokens";
import { addContribution, applyReading, attributionView, emptyLedger, normalizeLedger, recordHubSnapshot, replyWeight } from "./shared/attribution";
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
import { DEFAULT_SW_DIAG, DEFAULT_SYNC_STATE, type SwDiag, type TrayDiag, type UsageDiag, type Settings, type SyncState, type UsageEvent } from "./shared/types";
import { pickOrg, planOfOrgs } from "./shared/org";
import { explainCapturedEventError, sanitizeDeviceIds, validatePageMessage, validateWidgetRequest } from "./shared/validate";
import * as store from "./storage";
import { fetchAccountUsage } from "./sync/accountUsage";
import { buildReport, fetchHubState, normalizeBase, ping, sendReport } from "./sync/hub";

const HEARTBEAT = "heartbeat";
const SYNC_DEBOUNCE_MS = 3000;
const USAGE_POLL_NO_TAB_MS = 3 * 60_000;
const USAGE_POLL_MS = 55_000; // heartbeat is 1 min, so effectively every 1-2 min while a claude.ai tab is open
const READING_DELAYS_MS = [4_000, 20_000]; // extra account-usage readings after each reply

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
  // Keep the tray current even when no new reading was taken this minute (it marks stale data by age).
  void store.get("accountUsage").then(pushToTray, () => {});
  await syncNow();
}

const recordUsageDiag = (d: UsageDiag): void => {
  void store.set({ usageDiag: d }).catch(() => {});
};

async function pollAccountUsage(): Promise<void> {
  const [settings, orgId, current] = await Promise.all([
    store.get("settings"),
    store.get("orgId"),
    store.get("accountUsage"),
  ]);
  if (!settings.pollAccountUsage) return;
  const now = Date.now();
  // With a claude.ai tab open poll every ~1 min; otherwise every 3 min (the Usage Meter tray still needs it).
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const gap = tabs.length ? USAGE_POLL_MS : USAGE_POLL_NO_TAB_MS;
  if (now - Math.max(current?.fetchedAt ?? 0, lastUsageAttempt) < gap) return;
  let org = orgId;
  if (!org) {
    org = await discoverOrgId(undefined); // uses the claude.ai sign-in cookie; rate-limited
    if (!org) return;
    await store.set({ orgId: org });
  }
  lastUsageAttempt = now;
  const usage = await fetchAccountUsage(org, recordUsageDiag);
  if (usage) await storeUsage(usage);
}

// ---- Usage Meter (Windows tray app on this PC) ----
// The tray shows the plan limits of the Claude account used in Claude Desktop. Claude Desktop never exposes its
// sign-in, so this extension (signed in to the same account on claude.ai) hands its readings to the tray over
// localhost. Only plan %, reset times, plan name and the org id are sent — no tokens, cookies or message text.
const TRAY_URL = "http://127.0.0.1:47823/api/local-account";
async function pushToTray(usage: WidgetState["accountUsage"]): Promise<void> {
  const note = (d: Omit<TrayDiag, "at">) => void store.set({ trayDiag: { at: Date.now(), ...d } }).catch(() => {});
  if (!usage) return note({ status: null, note: "no plan usage read from claude.ai yet" });
  try {
    const [orgId, plan] = await Promise.all([store.get("orgId"), store.get("plan")]);
    const res = await fetch(TRAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, orgId, plan, usage }),
      signal: AbortSignal.timeout(3000),
    });
    note({ status: res.status });
  } catch (e) {
    // Tray not running is fine; the note says so in Diagnostics.
    note({ status: null, note: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : "unreachable" });
  }
}

/** Stores a fresh account-usage reading and feeds it to the per-model attribution ledger. */
async function storeUsage(usage: NonNullable<WidgetState["accountUsage"]>): Promise<void> {
  await store.set({ accountUsage: usage });
  void pushToTray(usage);
  try {
    await store.mutateLedger((l) => applyReading(l, usage, usage.fetchedAt));
  } catch (e) {
    console.warn("[claude-usage] attribution failed", e);
  }
}

let readingTimers: ReturnType<typeof setTimeout>[] = [];
/** After a reply (or hub activity) read the account usage again at +4 s and +20 s so the change is attributed to it. */
function scheduleReadings(): void {
  for (const t of readingTimers) clearTimeout(t);
  readingTimers = READING_DELAYS_MS.map((d) => setTimeout(() => void readingNow().catch((e) => console.warn("[claude-usage] reading failed", e)), d));
}

async function readingNow(): Promise<void> {
  const [settings, orgId] = await Promise.all([store.get("settings"), store.get("orgId")]);
  if (!settings.pollAccountUsage || !orgId) return;
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (!tabs.length) return;
  lastUsageAttempt = Date.now();
  const usage = await fetchAccountUsage(orgId, recordUsageDiag);
  if (usage) {
    await storeUsage(usage);
    void broadcastStateChanged();
  }
}

// ---- messages ----

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.tab) {
    if (sender.url?.startsWith("https://claude.ai/") && sender.id === chrome.runtime.id) {
      // The widget (ISOLATED content script) is the only content script that gets a response.
      const w = validateWidgetRequest(msg);
      if (w) {
        handleWidget(w.type, w.type === "get-widget-state" ? w.orgHint : undefined).then(sendResponse, (e) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return true;
      }
      const m = validatePageMessage(msg);
      if (m) void handlePage(m).catch((e) => console.warn("[claude-usage] page message failed", e));
      else if ((msg as { type?: unknown } | null)?.type === "usage-event") {
        const reason = explainCapturedEventError((msg as { payload?: unknown }).payload) ?? "invalid message";
        void bumpSwDiag({ eventsReceived: 1, eventsRejected: 1 }, reason).catch(() => {});
      }
    }
    return false;
  }
  if (sender.id !== chrome.runtime.id) return false;
  handleUi(msg as UiRequest).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});

let swDiagChain: Promise<void> = Promise.resolve();
/** Serialised read-modify-write of the persisted SW counters (the SW can be killed at any time). */
function bumpSwDiag(delta: Partial<Record<"eventsReceived" | "eventsRejected" | "eventsStored", number>>, reason?: string): Promise<void> {
  swDiagChain = swDiagChain
    .then(async () => {
      const cur = await store.get("swDiag");
      const next: SwDiag = {
        eventsReceived: cur.eventsReceived + (delta.eventsReceived ?? 0),
        eventsRejected: cur.eventsRejected + (delta.eventsRejected ?? 0),
        eventsStored: cur.eventsStored + (delta.eventsStored ?? 0),
        lastRejectReason: reason ? reason.slice(0, 120) : cur.lastRejectReason,
      };
      await store.set({ swDiag: next });
    })
    .catch(() => {});
  return swDiagChain;
}

async function handlePage(m: PageMessage): Promise<void> {
  switch (m.type) {
    case "diag":
      await store.set({ captureDiag: m.payload });
      return;
    case "usage-event": {
      void bumpSwDiag({ eventsReceived: 1 });
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
      void bumpSwDiag({ eventsStored: 1 });
      if (isNew) {
        try {
          const w = replyWeight(ev.model, ev.promptTokens, ev.outputTokens);
          await store.mutateLedger((l) => addContribution(l, { model: ev.model, weight: w, ts: Date.now(), source: "chrome" }));
          scheduleReadings();
        } catch (e) {
          console.warn("[claude-usage] attribution contribution failed", e);
        }
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
      void broadcastStateChanged();
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

/** Diffs hub devices' 5h token totals against the previous snapshot; positive deltas become attribution contributions. */
async function recordHub(devices: HubStateResult["devices"]): Promise<void> {
  try {
    const lite = devices.map((d) => ({
      deviceId: d.deviceId,
      source: d.source,
      last5hByModel: Object.fromEntries(Object.entries(d.windows.last5h.byModel).map(([m, v]) => [m, v.tokens])),
    }));
    let added = 0;
    await store.mutateLedger((l) => {
      const r = recordHubSnapshot(l, lite, Date.now());
      added = r.added;
      return r.ledger;
    });
    if (added > 0) scheduleReadings();
  } catch (e) {
    console.warn("[claude-usage] hub attribution failed", e);
  }
}

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
    if (result.ok) void recordHub(result.devices);
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
  void fetchAccountUsage(orgId, recordUsageDiag)
    .then(async (u) => {
      if (u) {
        await storeUsage(u);
        void broadcastStateChanged();
      }
    })
    .catch((e) => console.warn("[claude-usage] widget usage refresh failed", e));
}

const ORG_DISCOVERY_MIN_GAP_MS = 10 * 60_000;
const PLAN_REFRESH_MIN_GAP_MS = 6 * 3600_000;
let lastOrgDiscovery = 0;
let lastPlanAttempt = 0;

/** Learns the subscription plan from an /api/organizations response. Never throws. */
async function learnPlan(json: unknown, orgId: string | null): Promise<void> {
  try {
    const plan = planOfOrgs(json, orgId);
    if (plan && plan !== (await store.get("plan"))) {
      await store.set({ plan });
      void broadcastStateChanged();
    }
  } catch (e) {
    console.warn("[claude-usage] plan store failed", e);
  }
}

/** Plan unknown: ask which plan the org has, at most once per 6 h. Never throws. */
async function refreshPlan(orgId: string | null, hint: string | undefined): Promise<void> {
  const now = Date.now();
  if (now - lastPlanAttempt < PLAN_REFRESH_MIN_GAP_MS) return;
  lastPlanAttempt = now;
  try {
    const res = await fetch("https://claude.ai/api/organizations", { credentials: "include" });
    if (!res.ok) return;
    const json = await res.json();
    await learnPlan(json, orgId ?? pickOrg(json, hint));
  } catch (e) {
    console.warn("[claude-usage] plan refresh failed", e);
  }
}

/** Fallback when no orgId is known: ask claude.ai which organizations the session belongs to. Never throws. */
async function discoverOrgId(hint: string | undefined): Promise<string | null> {
  const now = Date.now();
  if (now - lastOrgDiscovery < ORG_DISCOVERY_MIN_GAP_MS) return null;
  lastOrgDiscovery = now;
  try {
    const res = await fetch("https://claude.ai/api/organizations", { credentials: "include" });
    if (!res.ok) {
      console.warn("[claude-usage] org discovery failed: HTTP", res.status);
      return null;
    }
    const json = await res.json();
    const id = pickOrg(json, hint);
    lastPlanAttempt = now; // this response also tells us the plan
    await learnPlan(json, id);
    if (!id) console.warn("[claude-usage] org discovery: no organization found");
    return id;
  } catch (e) {
    console.warn("[claude-usage] org discovery failed", e);
    return null;
  }
}

async function handleWidget(type: "get-widget-state" | "open-options", orgHint?: string): Promise<UiResponse> {
  try {
    if (type === "open-options") {
      await chrome.runtime.openOptionsPage();
      return { ok: true, data: null };
    }
    const [device, settings, syncState, accountUsage, events, orgId, captureDiag, swDiag, limitHint, ledger] = await Promise.all([
      store.ensureDevice(),
      store.get("settings"),
      store.get("syncState"),
      store.get("accountUsage"),
      store.get("events"),
      store.get("orgId"),
      store.get("captureDiag"),
      store.get("swDiag"),
      store.get("limitHint"),
      store.get("limitLedger"),
    ]);
    let org = orgId;
    let learned = false;
    if (orgHint && orgHint !== org) {
      org = orgHint; // the active org may change (cookie is authoritative)
      learned = true;
    } else if (!org && settings.pollAccountUsage) {
      org = await discoverOrgId(orgHint);
      learned = !!org;
    }
    if (learned && org) {
      await store.set({ orgId: org });
      lastWidgetUsageAttempt = 0; // allow an immediate usage fetch, which broadcasts state-changed
    }
    maybeRefreshUsageForWidget(settings, org, learned ? null : accountUsage);
    const plan = await store.get("plan");
    if (!plan) void refreshPlan(org, orgHint); // rate-limited to once per 6 h; broadcasts state-changed when learned
    const now = Date.now();
    const hub = await getHubState(settings); // may record hub contributions into the ledger
    const state: WidgetState = {
      device,
      aggregates: computeAggregates(events, now),
      accountUsage,
      attribution: attributionView(normalizeLedger(ledger)),
      plan,
      limitHint,
      syncState,
      showWidget: settings.showWidget,
      codeDeviceIds: sanitizeDeviceIds(settings.codeDeviceIds) ?? [],
      hub,
      now,
      captureDiag,
      swDiag,
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
        const ids = sanitizeDeviceIds(p.codeDeviceIds);
        if (ids) next.codeDeviceIds = ids;
        await store.set({ settings: next });
        if (typeof req.deviceName === "string") {
          const name = req.deviceName.trim().slice(0, 40);
          if (name) await store.set({ device: { ...(await store.ensureDevice()), deviceName: name } });
        }
        if (next.syncEnabled) scheduleSync();
        return ok<"save-settings">(await buildState());
      }
      case "get-hub-devices":
        return ok<"get-hub-devices">(await getHubState(await store.get("settings")));
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
      case "get-diag":
        return ok<"get-diag">({ page: await store.get("captureDiag"), sw: await store.get("swDiag"), usage: await store.get("usageDiag"), tray: await store.get("trayDiag") });
      case "reset-diag":
        await swDiagChain;
        await store.set({ captureDiag: null, swDiag: { ...DEFAULT_SW_DIAG }, usageDiag: null, trayDiag: null });
        return ok<"reset-diag">({ page: null, sw: { ...DEFAULT_SW_DIAG }, usage: null, tray: null });
      case "reset-attribution":
        await store.mutateLedger(() => emptyLedger());
        void broadcastStateChanged();
        return ok<"reset-attribution">(null);
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
        await store.mutateLedger(() => emptyLedger());
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
