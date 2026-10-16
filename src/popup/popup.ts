import { callSw } from "../shared/messages";
import type { UiState } from "../shared/messages";
import type { WindowName } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const WINDOWS: WindowName[] = ["today", "last5h", "last7d"];
const TAB_KEY = "popupTab";

let state: UiState | null = null;
let current: WindowName = "today";

try {
  const saved = localStorage.getItem(TAB_KEY) as WindowName | null;
  if (saved && WINDOWS.includes(saved)) current = saved;
} catch {
  /* storage unavailable */
}

function fmt(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 2 : 1).replace(/\.?0+$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

function humanWindow(name: string): string {
  if (name === "five_hour") return "5-hour";
  if (name === "seven_day") return "7-day";
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtReset(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.getTime() - Date.now() > 24 * 3600 * 1000) {
    return d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  }
  return time;
}

function renderSync(s: UiState): void {
  const ss = s.syncState;
  let cls = "off";
  let label = "sync off";
  if (s.settings.syncEnabled) {
    if (ss.lastError) {
      cls = "bad";
      label = "sync error: " + ss.lastError;
    } else if (ss.lastOkAt !== null && Date.now() - ss.lastOkAt < 120_000) {
      cls = "ok";
      label = "synced " + new Date(ss.lastOkAt).toLocaleTimeString();
    } else {
      cls = "warn";
      label = ss.lastOkAt ? "last synced " + new Date(ss.lastOkAt).toLocaleTimeString() : "not synced yet";
    }
  }
  const dot = $("dot");
  dot.className = "dot " + cls;
  dot.title = label;
  dot.setAttribute("aria-label", label);
}

function render(): void {
  if (!state) return;
  const s = state;
  $("device").textContent = s.device.deviceName || "This device";
  renderSync(s);

  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    const sel = b.dataset.win === current;
    b.setAttribute("aria-selected", String(sel));
    b.tabIndex = sel ? 0 : -1;
  }

  const w = s.aggregates[current];
  $("msgs").textContent = fmt(w.messages);
  $("ptok").textContent = fmt(w.promptTokens);
  $("otok").textContent = fmt(w.outputTokens);

  const entries = Object.entries(w.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  const list = $("models");
  list.replaceChildren();
  const max = entries.length ? Math.max(1, entries[0][1].tokens) : 1;
  for (const [model, agg] of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = shortModel(model);
    name.title = model;
    const msgs = document.createElement("span");
    msgs.className = "m";
    msgs.textContent = agg.messages + (agg.messages === 1 ? " msg" : " msgs");
    const tok = document.createElement("span");
    tok.textContent = "≈ " + fmt(agg.tokens);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = Math.max(2, (agg.tokens / max) * 100) + "%";
    bar.append(fill);
    li.append(name, msgs, tok, bar);
    list.append(li);
  }
  $("empty").hidden = w.messages > 0 || entries.length > 0;

  const acc = $("account");
  acc.replaceChildren();
  const wins = s.accountUsage?.windows ?? [];
  acc.hidden = wins.length === 0;
  for (const aw of wins) {
    const row = document.createElement("div");
    const reset = fmtReset(aw.resetsAt);
    row.textContent = `${humanWindow(aw.name)} limit ${Math.round(aw.utilization)}%` + (reset ? ` · resets ${reset}` : "");
    acc.append(row);
  }
}

function showError(msg: string | null): void {
  const e = $("error");
  e.hidden = !msg;
  e.textContent = msg ?? "";
}

async function refresh(): Promise<void> {
  const res = await callSw({ type: "get-state" });
  if (res.ok) {
    state = res.data;
    showError(null);
    render();
  } else {
    showError(res.error);
  }
}

function selectTab(w: WindowName): void {
  current = w;
  try {
    localStorage.setItem(TAB_KEY, w);
  } catch {
    /* ignore */
  }
  render();
}

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs button"));
tabs.forEach((b, i) => {
  b.addEventListener("click", () => selectTab(b.dataset.win as WindowName));
  b.addEventListener("keydown", (ev) => {
    let n = -1;
    if (ev.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") n = (i + tabs.length - 1) % tabs.length;
    if (n >= 0) {
      ev.preventDefault();
      selectTab(tabs[n].dataset.win as WindowName);
      tabs[n].focus();
    }
  });
});

$("opts").addEventListener("click", (ev) => {
  ev.preventDefault();
  void chrome.runtime.openOptionsPage();
});

$("sync").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("sync");
  btn.disabled = true;
  btn.classList.add("busy");
  const res = await callSw({ type: "sync-now" });
  if (!res.ok) showError(res.error);
  await refresh();
  btn.disabled = false;
  btn.classList.remove("busy");
});

void refresh();
setInterval(() => void refresh(), 5000);
