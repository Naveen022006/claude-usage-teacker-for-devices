import { callSw } from "../shared/messages";
import type { Settings } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deviceName = $<HTMLInputElement>("deviceName");
const urlEl = $<HTMLInputElement>("url");
const tokenEl = $<HTMLInputElement>("token");
const syncEl = $<HTMLInputElement>("syncEnabled");
const cptEl = $<HTMLInputElement>("cpt");
const cptOut = $<HTMLOutputElement>("cptOut");
const pollEl = $<HTMLInputElement>("poll");
const readSessionsEl = $<HTMLInputElement>("readSessions");
const widgetEl = $<HTMLInputElement>("showWidget");
const statusEl = $("status");
const devicesEl = $("codeDevices");
let codeIds = new Set<string>();

function setStatus(msg: string, kind: "" | "ok" | "warn" | "bad" = ""): void {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

/** Returns a parsed http(s) URL or null. */
function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const HTTP_WARN = "http:// is only for local testing; use https:// for a deployed hub.";
const BAD_URL = "Hub URL must start with https:// (or http:// for local testing).";

/**
 * Must be called synchronously from a click handler, before any other await,
 * so the user gesture is still valid. Resolves true if granted (or already held).
 */
function requestHostPermission(u: URL): Promise<boolean> {
  const pattern = `${u.protocol}//${u.hostname}/*`;
  return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
}

function fill(s: Settings): void {
  urlEl.value = s.hubUrl;
  tokenEl.value = s.hubToken;
  syncEl.checked = s.syncEnabled;
  cptEl.value = String(s.charsPerToken);
  cptOut.textContent = Number(s.charsPerToken).toFixed(1);
  pollEl.checked = s.pollAccountUsage;
  readSessionsEl.checked = s.readSessions;
  widgetEl.checked = s.showWidget;
  codeIds = new Set(s.codeDeviceIds ?? []);
  void loadHubDevices();
}

async function loadHubDevices(): Promise<void> {
  const res = await callSw({ type: "get-hub-devices" });
  devicesEl.replaceChildren();
  const note = (t: string) => devicesEl.append(Object.assign(document.createElement("span"), { textContent: t, className: "small" }));
  if (!res.ok) return note("Could not load devices: " + res.error);
  if (!res.data.configured) return note("Connect your Usage Hub above to list devices.");
  if (!res.data.ok) return note("Hub unreachable: " + (res.data.error ?? "unknown error"));
  const list = res.data.devices.filter((d) => d.source === "claude-code" || d.source === "desktop");
  if (!list.length) return note("No Claude Code or Desktop devices reported to the hub yet.");
  for (const d of list) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = codeIds.has(d.deviceId);
    cb.addEventListener("change", () => (cb.checked ? codeIds.add(d.deviceId) : codeIds.delete(d.deviceId)));
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = `${d.deviceName || d.deviceId.slice(0, 8)} (${d.source === "desktop" ? "Desktop" : "Claude Code"})${d.fresh ? "" : " - stale"}`;
    label.append(cb, span);
    devicesEl.append(label);
  }
}

async function load(): Promise<void> {
  const res = await callSw({ type: "get-state" });
  if (!res.ok) return setStatus("Could not load settings: " + res.error, "bad");
  deviceName.value = res.data.device.deviceName;
  $("deviceId").textContent = res.data.device.deviceId;
  fill(res.data.settings);
}

cptEl.addEventListener("input", () => {
  cptOut.textContent = Number(cptEl.value).toFixed(1);
});

function currentSettings(): Partial<Settings> {
  return {
    hubUrl: urlEl.value.trim().replace(/\/+$/, ""),
    hubToken: tokenEl.value,
    syncEnabled: syncEl.checked,
    charsPerToken: Number(cptEl.value),
    pollAccountUsage: pollEl.checked,
    readSessions: readSessionsEl.checked,
    showWidget: widgetEl.checked,
    codeDeviceIds: [...codeIds].slice(0, 20),
  };
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void onSave();
});

function onSave(): Promise<void> {
  const settings = currentSettings();
  const needsPerm = !!settings.syncEnabled && !!settings.hubUrl;
  const u = parseUrl(urlEl.value);
  if (needsPerm && !u) {
    setStatus(BAD_URL, "bad");
    return Promise.resolve();
  }
  if (!needsPerm && urlEl.value.trim() && !u) {
    setStatus(BAD_URL, "bad");
    return Promise.resolve();
  }
  // Call permissions.request first (synchronously) to keep the user gesture.
  const permP = needsPerm && u ? requestHostPermission(u) : Promise.resolve(true);
  return (async () => {
    const granted = await permP;
    const res = await callSw({ type: "save-settings", settings, deviceName: deviceName.value.trim() });
    if (!res.ok) return setStatus("Save failed: " + res.error, "bad");
    fill(res.data.settings);
    deviceName.value = res.data.device.deviceName;
    if (!granted) setStatus("Saved, but permission to reach that host was denied. Sync will fail until you allow it.", "warn");
    else if (u?.protocol === "http:") setStatus("Saved. " + HTTP_WARN, "warn");
    else setStatus("Saved.", "ok");
  })();
}

$("test").addEventListener("click", () => {
  const u = parseUrl(urlEl.value);
  if (!u) return setStatus(BAD_URL, "bad");
  const permP = requestHostPermission(u); // first, for the user gesture
  void (async () => {
    const granted = await permP;
    if (!granted) return setStatus("Permission to reach that host was denied.", "warn");
    // Persist URL/token so the SW tests what is on screen.
    const saved = await callSw({ type: "save-settings", settings: currentSettings() });
    if (!saved.ok) return setStatus("Save failed: " + saved.error, "bad");
    setStatus("Testing…");
    const res = await callSw({ type: "test-connection" });
    if (!res.ok) return setStatus("Test failed: " + res.error, "bad");
    const warn = u.protocol === "http:" ? " " + HTTP_WARN : "";
    if (res.data.reachable) setStatus("Connected: " + res.data.detail + warn, u.protocol === "http:" ? "warn" : "ok");
    else setStatus("Not reachable: " + res.data.detail, "bad");
  })();
});

$("export").addEventListener("click", async () => {
  const res = await callSw({ type: "export-data" });
  if (!res.ok) return setStatus("Export failed: " + res.error, "bad");
  const blob = new Blob([res.data.json], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  a.href = href;
  a.download = `claude-usage-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  setStatus("Exported.", "ok");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all recorded usage data on this device? This cannot be undone.")) return;
  const res = await callSw({ type: "clear-data" });
  setStatus(res.ok ? "Data cleared." : "Clear failed: " + res.error, res.ok ? "ok" : "bad");
});

// ---- diagnostics ----
type DiagData = { page: import("../shared/types").CaptureDiag | null; sw: import("../shared/types").SwDiag; usage?: import("../shared/types").UsageDiag | null; tray?: import("../shared/types").TrayDiag | null; sessions?: import("../sync/sessions").SessionsDiag | null };
let lastDiag: DiagData | null = null;

function fillTable(t: HTMLElement, head: string[] | null, rows: string[][]): void {
  t.replaceChildren();
  const mk = (tag: "th" | "td", cells: string[]) => {
    const tr = document.createElement("tr");
    for (const c of cells) tr.append(Object.assign(document.createElement(tag), { textContent: c }));
    t.append(tr);
  };
  if (head) mk("th", head);
  for (const r of rows) mk("td", r);
}

function renderDiag(d: DiagData): void {
  lastDiag = d;
  renderUsageDiag(d.usage, d.tray);
  renderSessionsDiag(d.sessions);
  const p = d.page;
  renderApiShapes(p?.apiShapes ?? []);
  const yn = (b: boolean) => (b ? "yes" : "no");
  fillTable($("diagCounters"), null, [
    ["Hook installed (last report)", p ? yn(p.hookInstalled) : "no report yet - reload claude.ai"],
    ["Last page report", p ? new Date(p.updatedAt).toLocaleTimeString() : "-"],
    ["fetch calls to /api/", String(p?.fetchCalls ?? 0)],
    ["Streams seen", String(p?.streamsSeen ?? 0)],
    ["Streams without known events", String(p?.emptyStreams ?? 0)],
    ["Events posted by page", String(p?.eventsPosted ?? 0)],
    ["Events received by service worker", String(d.sw.eventsReceived)],
    ["Events rejected", String(d.sw.eventsRejected) + (d.sw.lastRejectReason ? ` (last: ${d.sw.lastRejectReason})` : "")],
    ["Events stored", String(d.sw.eventsStored)],
  ]);
  fillTable(
    $("diagObs"),
    ["Time", "Path", "Type", "HTTP", "Match", "Events", "Recorded"],
    (p?.observations ?? []).slice().reverse().map((o) => [
      new Date(o.at).toLocaleTimeString(),
      o.pathPattern,
      o.contentType,
      String(o.status),
      yn(o.matchedRegex),
      o.eventTypes.join(", "),
      o.recorded ? "yes" : "no" + (o.reason ? `: ${o.reason}` : ""),
    ]),
  );
}

function shapeLines(s: import("../shared/types").ApiShape, indent = 0): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "string") out.push(`${"  ".repeat(indent)}${k}: ${v}`);
    else out.push(`${"  ".repeat(indent)}${k}:`, ...shapeLines(v, indent + 1));
  }
  return out;
}

function renderApiShapes(list: import("../shared/types").ApiShapeObservation[]): void {
  const rows = list.slice().reverse();
  const box = $("diagShapeList");
  box.replaceChildren();
  if (!rows.length) {
    fillTable($("diagShapes"), null, [["Open claude.ai \u2192 Settings (the page that lists your devices) with this extension enabled, then come back."]]);
    return;
  }
  fillTable($("diagShapes"), ["Time", "Path", "HTTP", "Sessions list?"], rows.map((o) => [
    new Date(o.at).toLocaleTimeString(), o.pathPattern, String(o.status), o.looksLikeSessionList ? "yes" : "\u2014",
  ]));
  for (const o of rows) {
    const d = document.createElement("details");
    const sum = Object.assign(document.createElement("summary"), { textContent: `${o.method} ${o.pathPattern}` });
    const pre = Object.assign(document.createElement("pre"), { textContent: shapeLines(o.shape).join("\n") });
    d.append(sum, pre);
    box.append(d);
  }
}

function renderUsageDiag(u: import("../shared/types").UsageDiag | null | undefined, tray: import("../shared/types").TrayDiag | null | undefined): void {
  const rows: string[][] = [];
  if (!u) rows.push(["Last /usage response", "none yet"]);
  else {
    rows.push(["Time", new Date(u.at).toLocaleTimeString()], ["HTTP", u.status === null ? "error" : String(u.status)], ["Parsed", u.parsed ? "yes" : "no"]);
    for (const [k, v] of Object.entries(u.shape)) rows.push([k, typeof v === "string" ? v : Object.entries(v).map(([a, b]) => `${a}: ${b}`).join(", ")]);
  }
  rows.push([
    "Sent to Usage Meter tray",
    tray ? `${new Date(tray.at).toLocaleTimeString()} · ${tray.status === null ? "not sent" : `HTTP ${tray.status}`}${tray.note ? ` · ${tray.note}` : ""}` : "not yet",
  ]);
  fillTable($("diagUsage"), null, rows);
}

function renderSessionsDiag(s: import("../sync/sessions").SessionsDiag | null | undefined): void {
  if (!s) return fillTable($("diagSessions"), null, [["Devices list", "not read yet"]]);
  fillTable($("diagSessions"), null, [
    ["Last read", new Date(s.at).toLocaleTimeString()],
    ["HTTP", s.status === null ? "error" : String(s.status)],
    ["Parsed", s.parsed ? "yes" : "no"],
    ["Sessions", String(s.count)],
    ["More pages", s.hasMore ? "yes" : "no"],
    ["user_agent keys", s.uaKeys.join(", ") || "-"],
  ]);
}

async function loadDiag(): Promise<void> {
  const res = await callSw({ type: "get-diag" });
  if (res.ok) renderDiag(res.data);
}

$("diagCopy").addEventListener("click", async () => {
  if (!lastDiag) await loadDiag();
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDiag, null, 2));
    setStatus("Diagnostics copied.", "ok");
  } catch (e) {
    setStatus("Copy failed: " + (e instanceof Error ? e.message : String(e)), "bad");
  }
});

$("diagReset").addEventListener("click", async () => {
  const res = await callSw({ type: "reset-diag" });
  if (res.ok) renderDiag(res.data);
});

$("attrReset").addEventListener("click", async () => {
  const res = await callSw({ type: "reset-attribution" });
  setStatus(res.ok ? "Model attribution reset." : "Reset failed: " + res.error, res.ok ? "ok" : "bad");
});

void loadDiag();
setInterval(() => {
  if (!document.hidden) void loadDiag();
}, 3000);

void load();
