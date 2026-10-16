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
const statusEl = $("status");

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

void load();
