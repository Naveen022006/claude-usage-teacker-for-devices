// Companion window renderer. DOM built with createElement/textContent only (never innerHTML with data).
import type { DesktopState, UsageMeterBridge } from "../shared/ipc";
import { buildView, countdownText, footerText, planFooterText, type PlanRowView, type View } from "./view";

declare global {
  interface Window {
    usageMeter?: UsageMeterBridge;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids) if (c) el.append(c);
  return el;
}

function clockIcon(): SVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = { viewBox: "0 0 24 24", width: "12", height: "12", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.classList.add("clk");
  for (const d of ["M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M12 9v4l2 2", "M10 2h4"]) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    el.append(p);
  }
  return el;
}

// ---- bridge (real, or fake state for the browser preview) ----

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

function fakeState(): DesktopState {
  const now = Date.now();
  const agg = (byModel: Record<string, { messages: number; tokens: number }>) => ({ messages: 0, promptTokens: 0, outputTokens: 0, byModel });
  const mk = (byModel: Record<string, { messages: number; tokens: number }>) => ({ today: agg({}), last5h: agg(byModel), last7d: agg({}) });
  const signedOut = params.has("signedout");
  const iso = (ms: number) => new Date(now + ms).toISOString();
  return {
    now,
    auth: { state: signedOut ? "signed-out" : "signed-in" },
    plan: signedOut ? null : "pro",
    accountUsage: signedOut ? null : { fetchedAt: now, windows: [
      { name: "five_hour", utilization: 79, resetsAt: iso((3 * 3600 + 5 * 60) * 1000) },
      { name: "seven_day", utilization: 11, resetsAt: iso((6 * 24 + 16) * 3600 * 1000) },
    ] },
    attribution: signedOut ? {} : {
      five_hour: { byModel: { "claude-opus-5-5": 52, "claude-sonnet-5-5": 19 }, other: 8 },
      seven_day: { byModel: { "claude-opus-5-5": 7, "claude-sonnet-5-5": 3 }, other: 1 },
    },
    local: [
      { source: "claude-code", aggregates: mk({ "claude-opus-5-5": { messages: 14, tokens: 48000 }, "claude-sonnet-5-5": { messages: 9, tokens: 21000 } }) },
      { source: "desktop", aggregates: mk({}) },
    ],
    tokens5hByModel: { "claude-opus-5-5": 48000, "claude-sonnet-5-5": 21000 },
    scan: { lastScanAt: now - 12_000, filesRead: 42 },
    ui: { alwaysOnTop: true, collapsed: params.has("collapsed") },
  };
}

/** Web bridge: served by the local Node server at /u/<key>/ (relative URLs keep the key). */
function webBridge(): UsageMeterBridge | null {
  if (typeof location === "undefined" || !/^\/u\/[^/]+\//.test(location.pathname)) return null;
  const base = location.pathname.replace(/[^/]*$/, "");
  return {
    async request<T = unknown>(req: Parameters<UsageMeterBridge["request"]>[0]): Promise<T> {
      const r = await fetch(`${base}api/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
      const j = (await r.json()) as { result: T };
      return j.result;
    },
    onState(cb) {
      const es = new EventSource(`${base}api/events`);
      es.onmessage = (e) => {
        try {
          cb(JSON.parse(e.data) as DesktopState);
        } catch {
          /* ignore */
        }
      };
      return () => es.close();
    },
  };
}

/** Shown while connected to the real app but before its first state arrives — never sample numbers. */
function emptyState(): DesktopState {
  return {
    now: Date.now(),
    auth: { state: "signing-in" },
    plan: null,
    accountUsage: null,
    attribution: {},
    local: [],
    tokens5hByModel: {},
    scan: { lastScanAt: null, filesRead: 0, error: "Connecting to Usage Meter…" },
    ui: { alwaysOnTop: true, collapsed: false },
  };
}

const bridge: UsageMeterBridge | null = typeof window !== "undefined" ? (window.usageMeter ?? webBridge()) : null;
// Sample data only for the file:// preview; a real window starts empty until the app answers.
let state: DesktopState = bridge ? emptyState() : fakeState();
const app = document.getElementById("app") as HTMLElement;
const forcedTheme = params.get("theme");
if (forcedTheme === "light" || forcedTheme === "dark") document.documentElement.setAttribute("data-theme", forcedTheme);

// preview only: headless browsers enforce a minimum window width, so allow pinning the panel width (?w=320).
const pinW = Number(params.get("w"));
if (!bridge && pinW > 0) app.style.width = `${pinW}px`;

function send(req: Parameters<UsageMeterBridge["request"]>[0]): void {
  if (!bridge) {
    if (req.type === "set-ui") {
      state = { ...state, ui: { ...state.ui, ...req.ui } };
      render();
    }
    return;
  }
  bridge.request(req).catch(() => {});
}

// ---- rendering ----

function bar(pct: number, tone: string, label: string, neutral = false): HTMLElement {
  const fill = h("div", { class: neutral ? "sb-fill neutral" : `sb-fill t-${tone}` });
  fill.style.width = `${pct}%`;
  return h("div", { class: "sb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)), "aria-label": label }, fill);
}

function countdown(iso: string | null): Node | null {
  const txt = countdownText(iso, Date.now());
  if (!txt) return null;
  const f = document.createDocumentFragment();
  f.append(clockIcon(), h("span", { class: "cd", "data-reset": iso! }, txt));
  return f;
}

function planRow(r: PlanRowView, withBar: boolean): HTMLElement {
  const name = r.label.replace(/:$/, "");
  if (r.kind === "pct") {
    const row = h("div", { class: "sb-row" }, h("span", { class: "sb-lbl", title: r.label }, r.label), h("span", { class: `sb-pct t-${r.tone}` }, `${Math.round(r.pct)}%`), h("span", { class: "sb-right" }, countdown(r.resetsAt)));
    return h("div", { class: "sb-item" }, row, withBar ? bar(r.pct, r.tone, name) : null);
  }
  const none = r.kind === "none";
  const row = h("div", { class: none ? "sb-row" : "sb-row txt" }, h("span", { class: "sb-lbl", title: r.label }, r.label), h("span", { class: none ? "sb-pct none" : `sb-pct t-${r.tone}` }, r.text), none ? h("span") : h("span", { class: "sb-right" }, countdown(r.resetsAt)));
  return h("div", { class: "sb-item" }, row, withBar ? bar(r.tone === "bad" && !none ? 100 : 0, r.tone, name) : null);
}

function modelsBlock(v: View): HTMLElement[] {
  const m = v.models;
  const out: HTMLElement[] = [];
  if (m.mode === "attr") {
    out.push(h("div", { class: "sb-sub sb-cols", title: "≈ attributed from changes in your plan usage after each reply" }, h("span", {}, "Models"), h("span", { class: "c" }, "5h"), h("span", { class: "c" }, "Week"), h("span", { class: "c" }, "Tokens")));
    const line = (r: (typeof m.attr)[number], muted: boolean) => {
      const row = h("div", { class: muted ? "sb-row attr other" : "sb-row attr" }, h("span", { class: "sb-lbl", title: r.label }, r.label), h("span", { class: "sb-pts" }, r.five), h("span", { class: "sb-pts" }, r.week), h("span", { class: "tk" }, r.tokens));
      return h("div", { class: "sb-item", title: r.title }, row, muted ? null : bar(r.bar, "ok", r.label.replace(/:$/, "")));
    };
    for (const r of m.attr) out.push(line(r, false));
    if (m.more) out.push(h("div", { class: "sb-none" }, `+${m.more} more`));
    if (m.other) out.push(line(m.other, true));
    return out;
  }
  out.push(h("div", { class: "sb-sub" }, "Models · last 5h"));
  if (!m.local.length) out.push(h("div", { class: "sb-none" }, "No local usage in the last 5 hours"));
  for (const r of m.local) {
    const row = h("div", { class: "sb-row mdl" }, h("span", { class: "sb-lbl", title: r.label }, r.label), h("span", { class: "sb-mid" }, r.mid), h("span", { class: "sb-right" }, r.right));
    out.push(h("div", { class: "sb-item", title: r.title }, row, bar(r.share, "ok", r.label.replace(/:$/, ""), true)));
  }
  if (m.more) out.push(h("div", { class: "sb-none" }, `+${m.more} more`));
  return out;
}

function render(): void {
  const v = buildView(state, Date.now());
  const collapsed = state.ui.collapsed;

  const title = h("button", { class: "title", type: "button", title: collapsed ? "Expand" : "Usage Meter" }, "Usage", v.planName ? h("span", { class: "plan" }, ` · ${v.planName}`) : null);
  title.addEventListener("click", () => {
    if (collapsed) send({ type: "set-ui", ui: { collapsed: false } });
  });
  const min = h("button", { class: "icon-btn", type: "button", title: collapsed ? "Expand" : "Collapse", "aria-label": collapsed ? "Expand" : "Collapse" }, collapsed ? "+" : "–");
  min.addEventListener("click", () => send({ type: "set-ui", ui: { collapsed: !collapsed } }));
  const close = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close" }, "×");
  close.addEventListener("click", () => {
    if (bridge) bridge.request({ type: "quit" }).catch(() => {});
    window.close();
  });

  const bodyKids: HTMLElement[] = [];
  if (collapsed) {
    bodyKids.push(planRow(v.rows[0] ?? { label: "Session (5h):", kind: "none", pct: 0, text: "—", tone: "ok", resetsAt: null }, false));
  } else {
    for (const r of v.rows) bodyKids.push(planRow(r, true));
    if (v.hint) bodyKids.push(h("div", { class: "sb-diag" }, v.hint));
    if (v.error) bodyKids.push(h("div", { class: "sb-diag err" }, v.error));
    bodyKids.push(...modelsBlock(v));
  }

  const kids: HTMLElement[] = [h("div", { class: "titlebar" }, title, h("div", { class: "btns" }, min, close)), h("div", { class: "body" }, ...bodyKids)];
  if (!collapsed) {
    const refresh = h("button", { class: "link", type: "button" }, "Refresh");
    refresh.addEventListener("click", () => send({ type: "refresh" }));
    kids.push(h("div", { class: "footer" }, h("div", { class: "txt" }, h("div", { id: "foot" }, v.footer), h("div", { id: "foot2" }, v.planFooter)), refresh));
  }
  app.className = collapsed ? "app collapsed" : "app";
  app.replaceChildren(...kids);
}

/** 1 s tick: only text nodes change. */
function tick(): void {
  const now = Date.now();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cd"))) {
    const t = countdownText(el.dataset.reset, now);
    if (t && el.textContent !== t) el.textContent = t;
  }
  const foot = document.getElementById("foot");
  if (foot) {
    const t = footerText(state, now);
    if (foot.textContent !== t) foot.textContent = t;
  }
  const foot2 = document.getElementById("foot2");
  if (foot2) {
    const t = planFooterText(state, now);
    if (foot2.textContent !== t) foot2.textContent = t;
  }
}

if (bridge) {
  bridge.onState((s) => {
    state = s;
    render();
  });
  bridge.request<DesktopState>({ type: "get-state" }).then((s) => {
    if (s) {
      state = s;
      render();
    }
  }).catch(() => {
    state = { ...state, scan: { ...state.scan, error: "Usage Meter isn't running — start it with npm start" } };
    render();
  });
}
render();
setInterval(tick, 1000);

// First run in an Edge app window: park it bottom-right (Edge remembers the position afterwards).
if (bridge && typeof window !== "undefined" && !window.usageMeter) {
  try {
    if (!localStorage.getItem("um-placed")) {
      localStorage.setItem("um-placed", "1");
      const sc = screen as Screen & { availLeft?: number; availTop?: number };
      window.moveTo((sc.availLeft ?? 0) + sc.availWidth - window.outerWidth - 16, (sc.availTop ?? 0) + sc.availHeight - window.outerHeight - 16);
    }
  } catch {
    /* ignore */
  }
}
