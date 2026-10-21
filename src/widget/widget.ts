// In-page usage widget (ISOLATED world content script, document_idle on https://claude.ai/*).
// Renders into a closed Shadow DOM with constructable stylesheets. Observes only: never touches
// claude.ai requests. Everything fails soft. No innerHTML anywhere (dynamic data uses textContent).

import { parseLastActiveOrg } from "../shared/org";
import { NS, type UiResponse, type WidgetState } from "../shared/messages";
import type { WindowAggregate } from "../shared/types";
import { HOST_ATTR, detectMode, placeHost, styleSampleRow, watchPlacement, type Mode, type Placement } from "./anchor";
import {
  TABS,
  clampPct,
  combineDevices,
  formatAgo,
  formatCountdown,
  formatResetsIn,
  modelShares,
  msUntil,
  pickWindow,
  themeFromColor,
  formatPct,
  planRows,
  modelRowView,
  PLAN_NAMES,
  formatTokens,
  humanizeWindow,
  mergeDevices,
  attributionRows,
  devicesPanel,
  DEVICES_FOOTER,
  type DeviceRowView,
  modelRows,
  pillLabel,
  sbTone,
  sortWindows,
  tone,
  totalsLine,
  type DeviceCard,
  type TabId,
} from "./helpers";
import { WIDGET_CSS } from "./styles";
import { SIDEBAR_CSS } from "./sidebarStyles";

const LOG = "[claude-usage]";
const UI_KEY = "widgetUi";
const REFRESH_OPEN_MS = 30_000;
const REFRESH_CLOSED_MS = 60_000;
const SVG_NS = "http://www.w3.org/2000/svg";

interface UiPrefs {
  expanded: boolean; // floating fallback: pill vs panel
  bottom: number; // floating fallback: px from the viewport bottom
  panelCollapsed: boolean; // sidebar panel: header only
}
const DEFAULT_BOTTOM = 88;

/** Preview/test hook (ISOLATED world, so the page cannot set it): overrides location.pathname for mode detection. */
const currentPath = (): string => (window as unknown as { __claudeUsagePath?: string }).__claudeUsagePath ?? location.pathname;

let alreadyRunning = false;

function warn(msg: string, e?: unknown): void {
  try {
    console.warn(LOG, msg, e instanceof Error ? e.message : (e ?? ""));
  } catch {
    /* ignore */
  }
}

// ---- tiny DOM helpers (no innerHTML) ----

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") el.style.cssText = v; // CSSOM, so a strict page CSP cannot block it
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

function svg(tag: string, attrs: Record<string, string>, ...kids: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids) el.append(c);
  return el;
}

const icon = (paths: string[], size = 16): SVGElement =>
  svg(
    "svg",
    { viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" },
    ...paths.map((d) => svg("path", { d })),
  );

const CLOCK = ["M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M12 9v4l2 2", "M10 2h4"];
const MINIMIZE = ["M6 9l6 6 6-6"];
const CHEVRON = ["M9 6l6 6-6 6"];

const clockIcon = (): SVGElement => {
  const el = icon(CLOCK, 12);
  el.classList.add("clk");
  return el;
};

const PLAN_LABELS: Record<string, string> = {
  five_hour: "Session (5h):",
  seven_day: "Weekly:",
  seven_day_opus: "Weekly Opus:",
  seven_day_sonnet: "Weekly Sonnet:",
  seven_day_fable: "Weekly Fable:",
};
const SB_WINDOWS: { id: TabId; label: string }[] = [
  { id: "session", label: "5h" },
  { id: "today", label: "Today" },
  { id: "week", label: "7d" },
  { id: "devices", label: "Devices" },
];
const SB_VIEWS: { id: TabId; label: string }[] = [
  { id: "session", label: "Models" },
  { id: "devices", label: "Devices" },
];
const MAX_MODEL_ROWS = 6;
const COUNTDOWN_MS = 1_000;

function ring(pct: number | null, size: number, stroke: number): SVGElement {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = pct === null ? 0 : clampPct(pct);
  const t = pct === null ? "none" : tone(p);
  const cx = String(size / 2);
  const arc = svg("circle", {
    cx, cy: cx, r: String(r), fill: "none", "stroke-width": String(stroke), "stroke-linecap": "round",
    "stroke-dasharray": `${(c * p) / 100} ${c}`, transform: `rotate(-90 ${cx} ${cx})`, class: `arc t-${t}`,
  });
  return svg(
    "svg",
    { viewBox: `0 0 ${size} ${size}`, width: String(size), height: String(size), "aria-hidden": "true", focusable: "false" },
    svg("circle", { cx, cy: cx, r: String(r), fill: "none", "stroke-width": String(stroke), class: "track" }),
    arc,
  );
}

// ---- messaging ----

let dead = false; // extension context invalidated

async function request<T>(type: "get-widget-state" | "open-options"): Promise<T | null> {
  if (dead) return null;
  try {
    const msg: Record<string, unknown> = { ns: NS, type };
    if (type === "get-widget-state") {
      let hint: string | null = null;
      try {
        hint = parseLastActiveOrg(document.cookie);
      } catch {
        /* cookie access blocked */
      }
      if (hint) msg.orgHint = hint;
    }
    const res = (await chrome.runtime.sendMessage(msg)) as UiResponse<T> | undefined;
    if (res && res.ok) return res.data;
    if (res && !res.ok) warn("request failed", res.error);
    return null;
  } catch (e) {
    if (e instanceof Error && /context invalidated/i.test(e.message)) dead = true;
    else warn("request error", e);
    return null;
  }
}

// ---- widget ----

class Widget {
  private host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLElement;
  private state: WidgetState | null = null;
  private prefs: UiPrefs = { expanded: false, bottom: DEFAULT_BOTTOM, panelCollapsed: false };
  private placement: Placement = "floating";
  private mode: Mode = "chat";
  private stopWatch: (() => void) | undefined;
  private countdown: ReturnType<typeof setInterval> | undefined;
  private lastSearch = 0;
  private tab: TabId = "session";
  private collapsedCards = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private loading = false;
  private mounted = false;

  constructor() {
    this.host = document.createElement("claude-usage-widget");
    this.host.setAttribute(HOST_ATTR, "");
    this.root = this.host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(WIDGET_CSS + SIDEBAR_CSS);
    this.root.adoptedStyleSheets = [sheet];
    this.wrap = h("div", { class: "wrap" });
    this.root.append(this.wrap);
    this.applyHostStyle();
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("visibilitychange", this.onVisibility);
    chrome.runtime.onMessage.addListener(this.onMessage);
    chrome.storage.onChanged.addListener(this.onStorage);
  }

  async start(): Promise<void> {
    try {
      const saved = (await chrome.storage.local.get(UI_KEY))[UI_KEY] as Partial<UiPrefs> | undefined;
      if (saved && typeof saved === "object") {
        if (typeof saved.expanded === "boolean") this.prefs.expanded = saved.expanded;
        if (typeof saved.bottom === "number" && Number.isFinite(saved.bottom)) this.prefs.bottom = saved.bottom;
        if (typeof saved.panelCollapsed === "boolean") this.prefs.panelCollapsed = saved.panelCollapsed;
      }
    } catch (e) {
      warn("could not read widget prefs", e);
    }
    await this.refresh();
    this.schedule();
    this.tick = setInterval(() => {
      if (this.mounted && this.placement === "floating" && this.prefs.expanded && !document.hidden) this.render(); // keeps "resets in" / "ago" fresh
    }, 15_000);
  }

  // -- lifecycle --

  private setMounted(on: boolean): void {
    if (on === this.mounted) return;
    this.mounted = on;
    if (on) {
      this.lastSearch = 0;
      this.place();
      this.stopWatch = watchPlacement(() => this.place());
    } else {
      this.stopWatch?.();
      this.stopWatch = undefined;
      this.host.remove();
      this.syncCountdown();
    }
  }

  /** (Re)attaches the host: below the Customize/More sidebar row when possible, else floating. Idempotent. */
  private place(): void {
    if (!this.mounted || dead) return;
    const path = currentPath();
    const now = Date.now();
    if (this.placement === "floating" && this.host.isConnected && this.mode === detectMode(path) && now - this.lastSearch < 1500) return;
    this.lastSearch = now;
    const before = { p: this.placement, m: this.mode };
    const r = placeHost(this.host, document, path);
    this.placement = r.placement;
    this.mode = r.mode;
    if (r.changed || before.p !== r.placement || before.m !== r.mode) {
      this.applyHostStyle(this.host.dataset.placement === "before" ? styleSampleRow(this.host, r.row) : r.row);
      this.render();
      this.syncCountdown();
    }
  }

  private applyHostStyle(row: Element | null = null): void {
    if (this.placement === "floating") {
      this.host.style.cssText = "all:initial;position:fixed;right:16px;z-index:2147483000;";
      this.host.removeAttribute("data-theme");
      this.applyPosition();
      return;
    }
    // Align the card with the sidebar rows' highlight box: inset of the row's inner link inside its wrapper.
    let left = 0;
    let right = 0;
    let theme: "dark" | "light" | null = null;
    try {
      if (row) {
        const inner = row.matches("a, button") ? row : (row.querySelector("a, button") ?? row);
        const rr = row.getBoundingClientRect();
        const ir = inner.getBoundingClientRect();
        if (ir.width > 0 && rr.width > 0) {
          left = Math.max(0, Math.min(40, ir.left - rr.left));
          right = Math.max(0, Math.min(40, rr.right - ir.right));
        }
        theme = themeFromColor(getComputedStyle(inner).color);
      }
    } catch {
      /* defaults */
    }
    this.host.style.cssText = `all:initial;display:block;box-sizing:border-box;font:inherit;color:inherit;padding:0 ${right}px 0 ${left}px;`;
    if (theme) this.host.setAttribute("data-theme", theme);
  }

  // -- live countdown: one 30 s interval, only while the sidebar panel is attached and the tab is visible --

  private syncCountdown(): void {
    const want = this.mounted && this.placement === "sidebar" && !document.hidden && !dead;
    if (want && !this.countdown) this.countdown = setInterval(() => this.tickCountdowns(), COUNTDOWN_MS);
    else if (!want && this.countdown) {
      clearInterval(this.countdown);
      this.countdown = undefined;
    }
  }

  private tickCountdowns(): void {
    try {
      if (dead) return this.destroy();
      if (document.hidden) return; // 1 s tick; nothing to update in a background tab
      for (const el of Array.from(this.root.querySelectorAll(".cd[data-reset]"))) {
        const ms = Date.parse(el.getAttribute("data-reset") ?? "") - Date.now();
        const txt = formatCountdown(ms);
        if (el.textContent !== txt) el.textContent = txt;
      }
    } catch {
      /* ignore */
    }
  }

  private onVisibility = (): void => {
    this.syncCountdown();
    if (!document.hidden) {
      this.lastSearch = 0;
      this.place();
      void this.refresh();
    }
  };

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (dead) return this.destroy();
      if (!document.hidden) await this.refresh();
      this.schedule();
    }, this.prefs.expanded || this.placement === "sidebar" ? REFRESH_OPEN_MS : REFRESH_CLOSED_MS);
  }

  private destroy(): void {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearInterval(this.countdown);
    this.countdown = undefined;
    this.stopWatch?.();
    this.stopWatch = undefined;
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
      chrome.storage.onChanged.removeListener(this.onStorage);
    } catch {
      /* ignore */
    }
    this.setMounted(false);
  }

  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const s = await request<WidgetState>("get-widget-state");
      if (s) this.state = s;
      else if (dead) return this.destroy();
      this.setMounted(!!this.state?.showWidget);
      if (this.mounted) {
        this.place();
        this.render();
      }
    } catch (e) {
      warn("refresh failed", e);
    } finally {
      this.loading = false;
    }
  }

  private onMessage = (msg: unknown, sender: chrome.runtime.MessageSender): void => {
    try {
      const m = msg as { ns?: unknown; type?: unknown } | null;
      if (sender.id === chrome.runtime.id && m && m.ns === NS && m.type === "state-changed") void this.refresh();
    } catch {
      /* ignore */
    }
  };

  private onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    try {
      if (area !== "local" || !changes.settings) return;
      const nv = (changes.settings.newValue ?? {}) as { showWidget?: unknown };
      if (typeof nv.showWidget === "boolean" && this.state) {
        this.state = { ...this.state, showWidget: nv.showWidget };
        this.setMounted(nv.showWidget);
        if (nv.showWidget) void this.refresh();
      }
    } catch {
      /* ignore */
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.placement === "floating" && this.prefs.expanded && this.mounted) this.setExpanded(false);
  };

  // -- prefs --

  private savePrefs(): void {
    try {
      void chrome.storage.local.set({ [UI_KEY]: this.prefs }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  private setExpanded(v: boolean): void {
    this.prefs.expanded = v;
    this.savePrefs();
    this.render();
    this.schedule();
    if (v) void this.refresh();
    // Return focus to the control that now exists.
    queueMicrotask(() => (this.root.querySelector(v ? ".panel" : ".pill") as HTMLElement | null)?.focus?.());
  }

  private applyPosition(): void {
    const max = Math.max(8, window.innerHeight - 60);
    this.prefs.bottom = Math.min(max, Math.max(8, this.prefs.bottom));
    this.host.style.bottom = `${this.prefs.bottom}px`;
  }

  /** Vertical drag on `handle`. A drag shorter than 4 px is treated as a click. */
  private makeDraggable(handle: HTMLElement): void {
    let startY = 0;
    let startBottom = 0;
    let moved = false;
    handle.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).closest("button") && handle.tagName !== "BUTTON") return;
      startY = ev.clientY;
      startBottom = this.prefs.bottom;
      moved = false;
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!handle.hasPointerCapture?.(ev.pointerId)) return;
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      if (moved) {
        this.prefs.bottom = startBottom - dy;
        this.applyPosition();
      }
    });
    const end = (ev: PointerEvent) => {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (moved) this.savePrefs();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener(
      "click",
      (ev) => {
        if (moved) {
          ev.stopImmediatePropagation();
          ev.preventDefault();
          moved = false;
        }
      },
      true,
    );
  }

  // -- rendering --

  private render(): void {
    try {
      const s = this.state;
      if (!s) return;
      const focusKey = (this.root.activeElement as HTMLElement | null)?.dataset?.fk ?? null;
      this.wrap.className = `wrap ${this.placement}`;
      if (this.placement === "sidebar") {
        this.wrap.replaceChildren(this.renderSidebar(s));
        if (focusKey) (this.root.querySelector(`[data-fk="${focusKey}"]`) as HTMLElement | null)?.focus();
        return;
      }
      const scroll = this.root.querySelector(".body")?.scrollTop ?? 0;
      this.applyPosition();
      this.wrap.replaceChildren(this.prefs.expanded ? this.renderPanel(s) : this.renderPill(s));
      const body = this.root.querySelector(".body");
      if (body) body.scrollTop = scroll;
      if (focusKey) (this.root.querySelector(`[data-fk="${focusKey}"]`) as HTMLElement | null)?.focus();
    } catch (e) {
      warn("render failed", e);
    }
  }

  // -- sidebar panel (flat rows: label, blue %, clock + countdown, thin bar) --

  private renderSidebar(s: WidgetState): HTMLElement {
    const open = !this.prefs.panelCollapsed;
    const box = h("section", { class: `sb${open ? " open" : ""}`, "aria-label": "Claude usage" });
    const toggle = h("button", { class: "sb-toggle", type: "button", "aria-expanded": String(open), "data-fk": "sb-toggle", title: open ? "Collapse" : "Expand" }, "Usage", s.plan ? h("span", { class: "sb-plan" }, ` · ${PLAN_NAMES[s.plan] ?? s.plan}`) : null);
    toggle.addEventListener("click", () => {
      this.prefs.panelCollapsed = !this.prefs.panelCollapsed;
      this.savePrefs();
      this.render();
    });
    box.append(h("div", { class: "sb-head" }, toggle), ...this.sbPlanRows(s, open));
    if (open) box.append(...this.sbModels(s));
    return box;
  }

  private sbBar(pct: number, t: string, label: string): HTMLElement {
    return h("div", { class: "sb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)), "aria-label": label },
      h("div", { class: `sb-fill t-${t}`, style: `width:${pct}%` }));
  }

  private sbRow(label: string, pct: number, t: string, right: Node | null, bar = true): HTMLElement {
    const row = h("div", { class: "sb-row" }, h("span", { class: "sb-lbl", title: label }, label), h("span", { class: `sb-pct t-${t}` }, `${Math.round(pct)}%`), right ? h("span", { class: "sb-right" }, right) : h("span"));
    return h("div", { class: "sb-item" }, row, bar ? this.sbBar(pct, t, label.replace(/:$/, "")) : null);
  }

  private sbCountdown(iso: string | undefined): Node | null {
    const ms = msUntil(iso, Date.now());
    if (ms === null) return null;
    const frag = document.createDocumentFragment();
    frag.append(clockIcon(), h("span", { class: "cd", "data-reset": iso! }, formatCountdown(ms)));
    return frag;
  }

  private sbPlanRows(s: WidgetState, open: boolean): HTMLElement[] {
    const ws = sortWindows(s.accountUsage?.windows ?? []);
    if (s.plan === "free" || (!s.plan && !ws.length)) return this.sbFreeRows(s, open);
    if (!ws.length) return [h("div", { class: "sb-none" }, "Plan usage unavailable")];
    const known = ws.filter((w) => PLAN_LABELS[w.name]);
    const list = known.length ? known : ws.slice(0, 1);
    const shown = open ? list : list.slice(0, 1);
    return shown.map((w) => {
      const pct = clampPct(w.utilization);
      return this.sbRow(PLAN_LABELS[w.name] ?? `${humanizeWindow(w.name)}:`, pct, sbTone(pct), this.sbCountdown(w.resetsAt), open);
    });
  }

  /** Free (or unknown plan, no account usage): always Session + Weekly rows; account usage -> limit hint -> "—". */
  private sbFreeRows(s: WidgetState, open: boolean): HTMLElement[] {
    const v = planRows(s.accountUsage, s.limitHint, s.plan, Date.now());
    const out = (open ? v.rows : v.rows.slice(0, 1)).map((r) => {
      if (r.kind === "pct") return this.sbRow(r.label, r.pct, r.tone, this.sbCountdown(r.resetsAt ?? undefined), open);
      const none = r.kind === "none";
      const val = h("span", { class: none ? "sb-pct none" : `sb-pct t-${r.tone}`, title: r.text }, r.text);
      const row = h("div", { class: none ? "sb-row" : "sb-row txt" }, h("span", { class: "sb-lbl", title: r.label }, r.label), val, none ? h("span") : h("span", { class: "sb-right" }, this.sbCountdown(r.resetsAt ?? undefined)));
      const barPct = r.kind === "text" && r.tone === "bad" ? 100 : 0;
      return h("div", { class: "sb-item" }, row, open ? this.sbBar(barPct, r.tone, r.label.replace(/:$/, "")) : null);
    });
    if (open && v.hint) out.push(h("div", { class: "sb-diag" }, v.hint));
    return out;
  }

  private sbOptionsLink(): HTMLElement {
    const a = h("button", { class: "sb-link", type: "button", "data-fk": "sb-connect" }, "Open options");
    a.addEventListener("click", () => void request("open-options"));
    return a;
  }

  /** `views` = Models | Devices (Pro/Max attribution layout); default = the time-window switch (Free layout). */
  private sbSwitch(views = false): HTMLElement {
    const wrapEl = h("div", { class: "sb-switch", role: "group", "aria-label": views ? "View" : "Time window" });
    (views ? SB_VIEWS : SB_WINDOWS).forEach((t, i) => {
      if (i) wrapEl.append(h("span", { class: "sep", "aria-hidden": "true" }, "·"));
      const sel = views ? (t.id === "devices") === (this.tab === "devices") : t.id === this.tab;
      const b = h("button", { type: "button", class: sel ? "on" : "", "aria-pressed": String(sel), "data-fk": `sb-win-${t.id}` }, t.label);
      b.addEventListener("click", () => {
        this.tab = t.id;
        this.render();
      });
      wrapEl.append(b);
    });
    return wrapEl;
  }

  /** Pro/Max: points of the 5h and weekly limits per model (estimated from usage changes), tokens muted on the right. */
  private sbAttribution(s: WidgetState): HTMLElement[] {
    const out: HTMLElement[] = [
      h("div", { class: "sb-sub sb-cols", title: "≈ attributed from changes in your plan usage after each reply" }, h("span", {}, "Model"), h("span", { class: "c" }, "5h"), h("span", { class: "c" }, "Week"), h("span", { class: "c" }, "Tokens")),
    ];
    const tokens: Record<string, number> = {};
    let estimated = true;
    const add = (byModel: WindowAggregate["byModel"]) => {
      for (const [m, v] of Object.entries(byModel)) tokens[m] = (tokens[m] ?? 0) + (v?.tokens || 0);
    };
    if (this.mode === "chat") add(s.aggregates.last5h.byModel);
    if (s.hub.configured && s.hub.ok) {
      const own = s.device.deviceId;
      const devs = this.mode === "chat" ? s.hub.devices.filter((d) => d.deviceId !== own) : combineDevices(s.hub.devices, s.codeDeviceIds ?? [], true).devices;
      for (const d of devs) {
        add(d.windows.last5h.byModel);
        if (d.estimated) estimated = true;
      }
      if (this.mode !== "chat") estimated = devs.some((d) => d.estimated) || !devs.length;
    }
    const view = attributionRows(s.attribution?.five_hour, s.attribution?.seven_day, tokens, estimated);
    const line = (v: { label: string; five: string; week: string; tokens: string; title: string; bar: number }, muted: boolean): HTMLElement => {
      const row = h("div", { class: `sb-row attr${muted ? " other" : ""}` }, h("span", { class: "sb-lbl", title: v.label }, v.label), h("span", { class: "sb-pts" }, v.five), h("span", { class: "sb-pts" }, v.week), h("span", { class: "tk" }, v.tokens));
      const bar = muted ? null : h("div", { class: "sb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(v.bar)), "aria-label": v.label.replace(/:$/, "") }, h("div", { class: "sb-fill", style: `width:${v.bar}%` }));
      return h("div", { class: "sb-item", title: v.title }, row, bar);
    };
    for (const r of view.rows.slice(0, MAX_MODEL_ROWS)) out.push(line(r, false));
    if (view.rows.length > MAX_MODEL_ROWS) out.push(h("div", { class: "sb-none" }, `+${view.rows.length - MAX_MODEL_ROWS} more`));
    out.push(line(view.other, true));
    return out;
  }

  private sbModels(s: WidgetState): HTMLElement[] {
    const ws = s.accountUsage?.windows ?? [];
    const attributed = s.plan !== "free" && ws.some((w) => w.name === "five_hour" || w.name === "seven_day");
    if (this.tab === "devices") return [h("div", { class: "sb-sub" }, h("span", {}, "Usage split"), this.sbSwitch(attributed)), ...this.sbDevices(s)];
    if (attributed) return [h("div", { class: "sb-sub" }, h("span", {}, "Usage split"), this.sbSwitch(true)), ...this.sbAttribution(s)];
    const out: HTMLElement[] = [h("div", { class: "sb-sub" }, h("span", {}, "Models"), this.sbSwitch())];
    let agg: WindowAggregate;
    let estimated: boolean;
    if (this.mode === "chat") {
      agg = pickWindow(s.aggregates, this.tab);
      estimated = true;
    } else {
      if (!s.hub.configured) {
        out.push(h("div", { class: "sb-msg" }, "Connect your Usage Hub in options to see Claude Code usage ", this.sbOptionsLink()));
        return out;
      }
      if (!s.hub.ok) {
        out.push(h("div", { class: "sb-msg" }, `Hub unreachable: ${s.hub.error ?? "unknown error"}. `, this.sbOptionsLink()));
        return out;
      }
      const combined = combineDevices(s.hub.devices, s.codeDeviceIds ?? [], true);
      if (!combined.devices.length) {
        out.push(h("div", { class: "sb-msg" }, "No Claude Code devices found on your hub."));
        return out;
      }
      agg = pickWindow(combined.windows, this.tab);
      estimated = !combined.exact;
    }
    const shares = modelShares(agg.byModel);
    if (!shares.length) {
      out.push(h("div", { class: "sb-none" }, "No usage in this window"));
      if (this.mode === "chat") out.push(...this.sbCaptureLines(s));
      return out;
    }
    for (const m of shares.slice(0, MAX_MODEL_ROWS)) {
      const v = modelRowView(m, estimated, this.mode === "chat" ? "this device's" : "these devices'");
      const row = h("div", { class: "sb-row mdl" }, h("span", { class: "sb-lbl", title: v.label }, v.label), h("span", { class: "sb-mid" }, v.mid), h("span", { class: "sb-right" }, h("span", { class: "tk" }, v.right)));
      const bar = h("div", { class: "sb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(v.share), "aria-label": v.label.replace(/:$/, "") }, h("div", { class: "sb-fill neutral", style: `width:${v.share}%` }));
      out.push(h("div", { class: "sb-item", title: v.title }, row, bar));
    }
    if (shares.length > MAX_MODEL_ROWS) out.push(h("div", { class: "sb-none" }, `+${shares.length - MAX_MODEL_ROWS} more`));
    return out;
  }

  /** Devices view (sidebar): per window, points of the limit used by each device + confidence. */
  private sbDevices(s: WidgetState): HTMLElement[] {
    const v = devicesPanel(s.devices, s.accountUsage, s.plan);
    if (v.kind === "empty") return [h("div", { class: "sb-none" }, v.message)];
    const out: HTMLElement[] = [];
    for (const sec of v.sections) {
      const cd = this.sbCountdown(sec.resetsAt ?? undefined);
      out.push(h("div", { class: "sb-sub" }, h("span", {}, sec.heading), cd ? h("span", { class: "sb-right" }, "resets in ", cd) : null));
      for (const r of sec.rows) out.push(this.sbDeviceRow(r));
      out.push(h("div", { class: "sb-none" }, sec.total));
      if (sec.since) out.push(h("div", { class: "sb-diag" }, sec.since));
    }
    out.push(h("div", { class: "sb-diag" }, DEVICES_FOOTER));
    return out;
  }

  private sbDeviceRow(r: DeviceRowView): HTMLElement {
    const badge = r.badge ? h("span", { class: `dev-badge ${r.badge === "Low" ? "low" : r.badge === "Medium" ? "medium" : "high"}`, title: r.title }, r.badge) : h("span");
    const row = h("div", { class: `sb-row dev${r.unattributed ? " other" : ""}`, "data-dev": r.key }, h("span", { class: "sb-pts" }, r.pts), h("span", { class: "sb-pts sh" }, r.share), badge);
    const label = h("div", { class: "sb-dev-lbl", title: r.label }, r.label);
    const bar = r.unattributed ? null : h("div", { class: "sb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(r.bar)), "aria-label": r.label }, h("div", { class: "sb-fill", style: `width:${r.bar}%` }));
    return h("div", { class: `sb-item sb-dev${r.unattributed ? " other" : ""}`, title: r.title }, label, row, bar, r.note ? h("div", { class: "sb-diag dev-note" }, r.note) : null);
  }

  /** Temporary capture diagnostics: counters, redacted path patterns and event-type names only. */
  private sbCaptureLines(s: WidgetState): HTMLElement[] {
    const d = s.captureDiag;
    if (!d) return [h("div", { class: "sb-diag", title: "No diagnostics received from the page script" }, "Capture: no data from page script (reload the tab)")];
    const sw = s.swDiag;
    let line = `Capture: hook ${d.hookInstalled ? "✓" : "✗"} · API calls ${d.fetchCalls} · streams ${d.streamsSeen} · recorded ${d.eventsPosted} · stored ${sw?.eventsStored ?? 0}`;
    if (sw && sw.eventsRejected > 0) line += ` · rejected ${sw.eventsRejected}${sw.lastRejectReason ? ` (${sw.lastRejectReason})` : ""}`;
    const out = [h("div", { class: "sb-diag", title: line }, line)];
    if (d.streamsSeen > 0 && d.eventsPosted === 0) {
      const last = d.observations?.[d.observations.length - 1];
      if (last) {
        const t = `Last stream: ${last.pathPattern} · ${last.eventTypes.slice(0, 5).join(", ") || "no events"}`;
        out.push(h("div", { class: "sb-diag cut", title: t }, t));
      }
    }
    return out;
  }

  private renderPill(s: WidgetState): HTMLElement {
    const five = s.accountUsage?.windows.find((w) => w.name === "five_hour");
    const label = pillLabel(s.accountUsage?.windows);
    const pill = h("button", { class: "pill", type: "button", "aria-label": `${label}. Open Claude usage`, "aria-expanded": "false", title: "Claude usage" });
    pill.append(ring(five ? five.utilization : null, 22, 3), h("span", { class: "pill-text" }, label));
    pill.addEventListener("click", () => this.setExpanded(true));
    this.makeDraggable(pill);
    return pill;
  }

  private renderPanel(s: WidgetState): HTMLElement {
    const now = Date.now();
    const panel = h("section", { class: "panel", role: "dialog", "aria-label": "Claude usage", tabindex: "-1" });

    // header
    const dot = h("span", { class: `dot ${this.syncTone(s)}`, role: "img", "aria-label": this.syncLabel(s), title: this.syncLabel(s) });
    const min = h("button", { class: "icon-btn", type: "button", "aria-label": "Minimize", title: "Minimize (Esc)", "data-fk": "min" }, icon(MINIMIZE));
    min.addEventListener("click", () => this.setExpanded(false));
    const title = h("div", { class: "title" }, h("span", {}, "Claude usage"), dot);
    const header = h("header", { class: "head" }, title, h("div", { class: "head-actions" }, min));
    this.makeDraggable(title);
    panel.append(header);

    const body = h("div", { class: "body" });
    body.append(this.renderPlan(s, now), this.renderTabs(), ...this.renderDevices(s, now));
    panel.append(body, this.renderFooter(s, now));
    return panel;
  }

  private renderPlan(s: WidgetState, now: number): HTMLElement {
    const sec = h("div", { class: "plan" });
    const ws = sortWindows(s.accountUsage?.windows ?? []);
    if (!ws.length) {
      sec.append(h("p", { class: "muted" }, "Plan usage unavailable"));
      return sec;
    }
    for (const w of ws) {
      const pct = clampPct(w.utilization);
      const reset = formatResetsIn(w.resetsAt, now);
      const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)), "aria-label": humanizeWindow(w.name) });
      bar.append(h("div", { class: `fill t-${tone(pct)}`, style: `width:${pct}%` }));
      sec.append(
        h("div", { class: "win" },
          h("div", { class: "win-top" }, h("span", { class: "win-name" }, humanizeWindow(w.name)), h("span", { class: "win-pct" }, formatPct(pct))),
          bar,
          reset ? h("div", { class: "small muted" }, reset === "now" ? "resetting now" : `resets in ${reset}`) : null,
        ),
      );
    }
    return sec;
  }

  private renderTabs(): HTMLElement {
    const list = h("div", { class: "tabs", role: "tablist", "aria-label": "Time window" });
    TABS.forEach((t, i) => {
      const sel = t.id === this.tab;
      const b = h("button", { class: "tab", type: "button", role: "tab", id: `tab-${t.id}`, "aria-selected": String(sel), "aria-controls": "devices", tabindex: sel ? "0" : "-1", "data-fk": `tab-${t.id}` }, t.label);
      b.addEventListener("click", () => {
        this.tab = t.id;
        this.render();
      });
      b.addEventListener("keydown", (ev) => {
        const d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
        this.render();
        (this.root.querySelector(`#tab-${this.tab}`) as HTMLElement | null)?.focus();
      });
      list.append(b);
    });
    return list;
  }

  /** Devices tab of the floating panel. */
  private renderDeviceUsage(s: WidgetState, now: number): HTMLElement {
    const wrap = h("div", { class: "devices", id: "devices", role: "tabpanel", "aria-labelledby": "tab-devices" });
    const v = devicesPanel(s.devices, s.accountUsage, s.plan);
    if (v.kind === "empty") {
      wrap.append(h("p", { class: "small muted" }, v.message));
      return wrap;
    }
    for (const sec of v.sections) {
      const reset = formatResetsIn(sec.resetsAt ?? undefined, now);
      const card = h("div", { class: "card open" }, h("div", { class: "dev-head" }, h("span", { class: "card-title" }, sec.heading), reset ? h("span", { class: "small muted" }, reset === "now" ? "resetting now" : `resets in ${reset}`) : null));
      for (const r of sec.rows) {
        const bar = r.unattributed ? null : h("div", { class: "mbar", "aria-hidden": "true" }, h("div", { class: "mfill", style: `width:${Math.max(2, r.bar)}%` }));
        card.append(
          h("div", { class: `mrow dev${r.unattributed ? " other" : ""}`, title: r.title, "data-dev": r.key },
            h("span", { class: "mname" }, r.label),
            h("span", { class: "mnum" }, `${r.pts} · ${r.share}`),
            r.badge ? h("span", { class: `dev-badge ${r.badge === "Low" ? "low" : r.badge === "Medium" ? "medium" : "high"}`, title: r.title }, r.badge) : h("span"),
            bar,
          ),
        );
        if (r.note) card.append(h("div", { class: "small muted dev-note" }, r.note));
      }
      card.append(h("div", { class: "totals" }, sec.total));
      if (sec.since) card.append(h("div", { class: "small muted" }, sec.since));
      wrap.append(card);
    }
    wrap.append(h("p", { class: "small muted" }, DEVICES_FOOTER));
    return wrap;
  }

  private renderDevices(s: WidgetState, now: number): HTMLElement[] {
    if (this.tab === "devices") return [this.renderDeviceUsage(s, now)];
    const win = TABS.find((t) => t.id === this.tab)!.window;
    const cards = mergeDevices({ deviceId: s.device.deviceId, windows: s.aggregates }, s.hub.devices);
    const wrap = h("div", { class: "devices", id: "devices", role: "tabpanel", "aria-labelledby": `tab-${this.tab}` });
    for (const c of cards) wrap.append(this.renderCard(c, win, now));
    return [wrap];
  }

  private renderCard(c: DeviceCard, win: "last5h" | "today" | "last7d", now: number): HTMLElement {
    const w = c.windows[win];
    const open = !this.collapsedCards.has(c.key);
    const head = h("button", { class: "card-head", type: "button", "aria-expanded": String(open), "data-fk": `card-${c.key}` });
    const chev = icon(CHEVRON, 14);
    chev.classList.add("chev");
    const sub = c.fresh ? null : h("span", { class: "stale" }, `stale · seen ${formatAgo(c.receivedAt, now)}`);
    head.append(
      chev,
      h("span", { class: "card-title" }, c.title),
      h("span", { class: "badge" }, c.badge),
    );
    if (sub) head.append(sub);
    head.addEventListener("click", () => {
      if (this.collapsedCards.has(c.key)) this.collapsedCards.delete(c.key);
      else this.collapsedCards.add(c.key);
      this.render();
    });
    const card = h("div", { class: `card${c.fresh ? "" : " is-stale"}${open ? " open" : ""}` }, head);
    card.append(h("div", { class: "totals" }, totalsLine(w, c.estimated)));
    if (open) {
      const rows = modelRows(w);
      if (!rows.length) card.append(h("p", { class: "small muted" }, "No messages in this window"));
      for (const r of rows) {
        const bar = h("div", { class: "mbar", "aria-hidden": "true" }, h("div", { class: "mfill", style: `width:${Math.max(2, r.share)}%` }));
        card.append(
          h("div", { class: "mrow" },
            h("span", { class: "mname", title: r.model }, r.model),
            h("span", { class: "mnum" }, `${r.messages} ${r.messages === 1 ? "msg" : "msgs"}`),
            h("span", { class: "mnum" }, `${c.estimated ? "≈" : ""}${formatTokens(r.tokens)} tok`),
            bar,
          ),
        );
      }
    }
    return card;
  }

  private renderFooter(s: WidgetState, now: number): HTMLElement {
    const foot = h("footer", { class: "foot" });
    foot.append(h("span", { class: "small muted" }, `Updated ${formatAgo(s.now, now)}`));
    const hubLine = h("span", { class: "small muted hub" });
    if (!s.hub.configured) {
      const a = h("button", { class: "link", type: "button", "data-fk": "connect" }, "Connect a Usage Hub to see Claude Code & Desktop");
      a.addEventListener("click", () => void request("open-options"));
      hubLine.append(a);
    } else if (!s.hub.ok) {
      hubLine.append(`Hub unreachable: ${s.hub.error ?? "unknown error"}`);
      hubLine.classList.add("err");
    } else {
      hubLine.append(`Hub OK · ${formatAgo(s.hub.fetchedAt, now)}`);
    }
    foot.append(hubLine);
    return foot;
  }

  private syncTone(s: WidgetState): "ok" | "warn" | "bad" | "off" {
    if (s.syncState.lastError) return "bad";
    if (s.hub.configured && !s.hub.ok) return "bad";
    if (!s.hub.configured) return "off";
    return s.syncState.lastOkAt && Date.now() - s.syncState.lastOkAt < 120_000 ? "ok" : "warn";
  }

  private syncLabel(s: WidgetState): string {
    const t = this.syncTone(s);
    if (t === "off") return "Hub not connected";
    if (t === "bad") return `Sync problem: ${s.syncState.lastError ?? s.hub.error ?? "hub unreachable"}`;
    if (t === "ok") return "Synced with hub";
    return "Hub sync pending";
  }
}


function main(): void {
  try {
    if (alreadyRunning || window.top !== window) return;
    alreadyRunning = true;
    if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in Document.prototype)) return;
    void new Widget().start().catch((e) => warn("widget failed to start", e));
  } catch (e) {
    warn("widget failed to start", e);
  }
}

main();
