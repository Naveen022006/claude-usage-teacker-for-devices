// In-page usage widget (ISOLATED world content script, document_idle on https://claude.ai/*).
// Renders into a closed Shadow DOM with constructable stylesheets. Observes only: never touches
// claude.ai requests. Everything fails soft. No innerHTML anywhere (dynamic data uses textContent).

import { NS, type UiResponse, type WidgetState } from "../shared/messages";
import {
  TABS,
  clampPct,
  formatAgo,
  formatCountdown,
  formatPct,
  formatTokens,
  humanizeWindow,
  mergeDevices,
  modelRows,
  pillLabel,
  sortWindows,
  tone,
  totalsLine,
  type DeviceCard,
  type TabId,
} from "./helpers";
import { WIDGET_CSS } from "./styles";

const LOG = "[claude-usage]";
const UI_KEY = "widgetUi";
const REFRESH_OPEN_MS = 30_000;
const REFRESH_CLOSED_MS = 60_000;
const SVG_NS = "http://www.w3.org/2000/svg";

interface UiPrefs {
  expanded: boolean;
  bottom: number; // px from the viewport bottom
}
const DEFAULT_BOTTOM = 88;

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

const GEAR = [
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
];
const MINIMIZE = ["M6 9l6 6 6-6"];
const CHEVRON = ["M9 6l6 6-6 6"];

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
    const res = (await chrome.runtime.sendMessage({ ns: NS, type })) as UiResponse<T> | undefined;
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
  private prefs: UiPrefs = { expanded: false, bottom: DEFAULT_BOTTOM };
  private tab: TabId = "session";
  private collapsedCards = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private loading = false;
  private mounted = false;

  constructor() {
    this.host = document.createElement("claude-usage-widget");
    this.host.style.cssText = "all:initial;position:fixed;right:16px;z-index:2147483000;";
    this.root = this.host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(WIDGET_CSS);
    this.root.adoptedStyleSheets = [sheet];
    this.wrap = h("div", { class: "wrap" });
    this.root.append(this.wrap);
    this.applyPosition();
    document.addEventListener("keydown", this.onKey, true);
    chrome.runtime.onMessage.addListener(this.onMessage);
    chrome.storage.onChanged.addListener(this.onStorage);
  }

  async start(): Promise<void> {
    try {
      const saved = (await chrome.storage.local.get(UI_KEY))[UI_KEY] as Partial<UiPrefs> | undefined;
      if (saved && typeof saved === "object") {
        if (typeof saved.expanded === "boolean") this.prefs.expanded = saved.expanded;
        if (typeof saved.bottom === "number" && Number.isFinite(saved.bottom)) this.prefs.bottom = saved.bottom;
      }
    } catch (e) {
      warn("could not read widget prefs", e);
    }
    await this.refresh();
    this.schedule();
    this.tick = setInterval(() => {
      if (this.mounted && this.prefs.expanded && !document.hidden) this.render(); // keeps "resets in" / "ago" fresh
    }, 15_000);
  }

  // -- lifecycle --

  private setMounted(on: boolean): void {
    if (on === this.mounted) return;
    this.mounted = on;
    if (on) (document.body ?? document.documentElement).append(this.host);
    else this.host.remove();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (dead) return this.destroy();
      if (!document.hidden) await this.refresh();
      this.schedule();
    }, this.prefs.expanded ? REFRESH_OPEN_MS : REFRESH_CLOSED_MS);
  }

  private destroy(): void {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    document.removeEventListener("keydown", this.onKey, true);
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
      if (this.mounted) this.render();
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
    if (e.key === "Escape" && this.prefs.expanded && this.mounted) this.setExpanded(false);
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
    const gear = h("button", { class: "icon-btn", type: "button", "aria-label": "Open settings", title: "Settings", "data-fk": "gear" }, icon(GEAR));
    gear.addEventListener("click", () => void request("open-options"));
    const min = h("button", { class: "icon-btn", type: "button", "aria-label": "Minimize", title: "Minimize (Esc)", "data-fk": "min" }, icon(MINIMIZE));
    min.addEventListener("click", () => this.setExpanded(false));
    const title = h("div", { class: "title" }, h("span", {}, "Claude usage"), dot);
    const header = h("header", { class: "head" }, title, h("div", { class: "head-actions" }, gear, min));
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
      const reset = formatCountdown(w.resetsAt, now);
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

  private renderDevices(s: WidgetState, now: number): HTMLElement[] {
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
