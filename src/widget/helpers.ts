// Pure helpers for the in-page widget (tested in test/widget.test.ts). No DOM, no chrome.*.

import type { DeviceView, DeviceWindowView } from "../shared/deviceAttribution";
import type { HubDevice } from "../shared/messages";
import type { AccountWindow, Aggregates, Source, WindowAggregate, WindowName } from "../shared/types";

export type TabId = "session" | "today" | "week" | "devices";
export const TABS: { id: TabId; label: string; window: WindowName }[] = [
  { id: "session", label: "Session (5h)", window: "last5h" },
  { id: "today", label: "Today", window: "today" },
  { id: "week", label: "7 days", window: "last7d" },
  // "devices" is a different view (per-device plan points); its `window` only keeps TabId -> aggregate lookups safe.
  { id: "devices", label: "Devices", window: "last5h" },
];

export type Tone = "ok" | "warn" | "bad";

/** green < 60, amber < 85, red >= 85 */
export function tone(pct: number): Tone {
  return pct >= 85 ? "bad" : pct >= 60 ? "warn" : "ok";
}

export function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

export function formatPct(n: number): string {
  return `${Math.round(clampPct(n))}%`;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Current session (5h)",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_fable: "Weekly · Fable",
};

export function humanizeWindow(name: string): string {
  const known = WINDOW_LABELS[name];
  if (known) return known;
  return name
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** five_hour first, then seven_day*, then the rest alphabetically. */
export function sortWindows(ws: AccountWindow[]): AccountWindow[] {
  const rank = (n: string) => (n === "five_hour" ? 0 : n === "seven_day" ? 1 : n.startsWith("seven_day") ? 2 : 3);
  return ws.slice().sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** "2h 14m", "14m", "3d 4h", "now"; "" if unknown/invalid. (floating widget) */
export function formatResetsIn(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.ceil((t - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "12s ago", "5m ago", "2h ago", "3d ago". */
export function formatAgo(ts: number | null | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 2 : 1).replace(/\.?0+$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

export function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

export const SOURCE_BADGE: Record<Source, string> = {
  chrome: "Claude.ai",
  "claude-code": "Claude Code",
  desktop: "Desktop",
};

export interface DeviceCard {
  key: string;
  title: string;
  badge: string;
  estimated: boolean;
  fresh: boolean;
  receivedAt: number | null; // null for this browser
  windows: Aggregates;
}

/** This browser first (always), then hub devices excluding this browser's own deviceId. */
export function mergeDevices(
  own: { deviceId: string; windows: Aggregates },
  hub: HubDevice[],
): DeviceCard[] {
  const cards: DeviceCard[] = [
    {
      key: "local:" + own.deviceId,
      title: "This browser",
      badge: SOURCE_BADGE.chrome,
      estimated: true,
      fresh: true,
      receivedAt: null,
      windows: own.windows,
    },
  ];
  const sorted = hub
    .filter((d) => d.deviceId !== own.deviceId)
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.receivedAt - a.receivedAt);
  for (const d of sorted) {
    cards.push({
      key: "hub:" + d.deviceId,
      title: d.deviceName || d.deviceId.slice(0, 8),
      badge: SOURCE_BADGE[d.source] ?? d.source,
      estimated: d.estimated,
      fresh: d.fresh,
      receivedAt: d.receivedAt,
      windows: d.windows,
    });
  }
  return cards;
}

export interface ModelRow {
  model: string;
  messages: number;
  tokens: number;
  /** 0–100 relative to the largest row in the card */
  share: number;
}

export function modelRows(w: WindowAggregate): ModelRow[] {
  const rows = Object.entries(w.byModel).map(([m, v]) => ({ model: shortModel(m), messages: v.messages, tokens: v.tokens }));
  rows.sort((a, b) => b.messages - a.messages || b.tokens - a.tokens || a.model.localeCompare(b.model));
  const max = Math.max(0, ...rows.map((r) => r.tokens || r.messages));
  return rows.map((r) => ({ ...r, share: max ? ((r.tokens || r.messages) / max) * 100 : 0 }));
}

export function totalsLine(w: WindowAggregate, estimated: boolean): string {
  const a = estimated ? "≈" : "";
  const msgs = `${w.messages} ${w.messages === 1 ? "msg" : "msgs"}`;
  return `${msgs} · ${a}${formatTokens(w.promptTokens)} in / ${a}${formatTokens(w.outputTokens)} out`;
}

/** Pill text: "5h 42%" or "Usage". */
export function pillLabel(ws: AccountWindow[] | undefined): string {
  const w = ws?.find((x) => x.name === "five_hour");
  return w ? `5h ${formatPct(w.utilization)}` : "Usage";
}

// ---- sidebar panel helpers ----

/** Countdown with seconds: "45s", "12m 05s", "3h 20m 15s", "6d 16h 20m 15s"; "now" when elapsed. Callers refresh it every 1 s. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "now";
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const ss = String(s).padStart(2, "0");
  if (d >= 1) return `${d}d ${h}h ${m}m ${ss}s`;
  if (h >= 1) return `${h}h ${m}m ${ss}s`;
  if (m >= 1) return `${m}m ${ss}s`;
  return `${s}s`;
}

/** Sidebar tone: blue (ok) < 80, amber >= 80, red >= 95. */
export function sbTone(pct: number): Tone {
  return pct >= 95 ? "bad" : pct >= 80 ? "warn" : "ok";
}

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5"; unknown -> id without "claude-". */
export function prettyModel(id: string): string {
  const raw = String(id ?? "").replace(/^claude-/, "");
  const cap = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
  const ver = (a: string, b?: string) => (b !== undefined ? `${a}.${b}` : a);
  // family first: sonnet-5-5, haiku-4-5-20251001, fable-5-1, opus-4
  let m = /^([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(raw);
  if (m && !/^\d+$/.test(m[1])) return `${cap(m[1])} ${ver(m[2], m[3])}`;
  // version first: 3-5-sonnet-20241022, 3-opus-20240229
  m = /^(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(raw);
  if (m) return `${cap(m[3])} ${ver(m[1], m[2])}`;
  return raw;
}

/** ms until an ISO timestamp, or null if missing/invalid. */
export function msUntil(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t - now : null;
}

export interface ModelShare {
  model: string;
  label: string; // prettyModel(id)
  pct: number; // integer, all shares sum to exactly 100
  tokens: number;
  messages: number;
}

/** Share of each model by tokens (messages if no tokens at all), largest-remainder rounded, sorted desc. */
export function modelShares(byModel: WindowAggregate["byModel"]): ModelShare[] {
  const entries = Object.entries(byModel ?? {}).map(([m, v]) => ({ model: shortModel(m), tokens: v?.tokens || 0, messages: v?.messages || 0, label: prettyModel(m) }));
  const byTokens = entries.some((e) => e.tokens > 0);
  const weight = (e: { tokens: number; messages: number }) => (byTokens ? e.tokens : e.messages);
  const rows = entries.filter((e) => weight(e) > 0);
  const total = rows.reduce((a, e) => a + weight(e), 0);
  if (!total) return [];
  const raw = rows.map((e) => ({ e, exact: (weight(e) / total) * 100 }));
  const out = raw.map((r) => ({ ...r, pct: Math.floor(r.exact) }));
  let left = 100 - out.reduce((a, r) => a + r.pct, 0);
  [...out]
    .sort((a, b) => b.exact - b.pct - (a.exact - a.pct) || weight(b.e) - weight(a.e))
    .forEach((r) => {
      if (left > 0) {
        r.pct += 1;
        left -= 1;
      }
    });
  return out
    .map((r) => ({ model: r.e.model, label: r.e.label, pct: r.pct, tokens: r.e.tokens, messages: r.e.messages }))
    .sort((a, b) => b.pct - a.pct || b.tokens - a.tokens || a.model.localeCompare(b.model));
}

export const CODE_SOURCES: Source[] = ["claude-code", "desktop"];

export interface CombinedDevices {
  windows: Aggregates;
  devices: HubDevice[];
  exact: boolean; // false if any combined device reports estimates
}

const emptyWin = (): WindowAggregate => ({ messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} });

/**
 * Sums selected hub devices. `ids` non-empty -> exactly those devices; empty + auto -> all devices whose
 * source is claude-code or desktop; empty + !auto -> none.
 */
export function combineDevices(devices: HubDevice[], ids: string[], auto = true): CombinedDevices {
  const picked = ids.length ? devices.filter((d) => ids.includes(d.deviceId)) : auto ? devices.filter((d) => CODE_SOURCES.includes(d.source)) : [];
  const windows: Aggregates = { today: emptyWin(), last5h: emptyWin(), last7d: emptyWin() };
  for (const d of picked) {
    for (const k of ["today", "last5h", "last7d"] as const) {
      const src = d.windows[k];
      const dst = windows[k];
      dst.messages += src.messages;
      dst.promptTokens += src.promptTokens;
      dst.outputTokens += src.outputTokens;
      for (const [m, v] of Object.entries(src.byModel)) {
        const cur = (dst.byModel[m] ??= { messages: 0, tokens: 0 });
        cur.messages += v.messages;
        cur.tokens += v.tokens;
      }
    }
  }
  return { windows, devices: picked, exact: picked.every((d) => !d.estimated) };
}

export function pickWindow(a: Aggregates, tab: TabId): WindowAggregate {
  return a[TABS.find((t) => t.id === tab)?.window ?? "last5h"];
}

/** "dark" when the (sidebar) text colour is light, else "light". Accepts rgb()/rgba()/color(srgb ...). */
export function themeFromColor(css: string): "dark" | "light" | null {
  const nums = css.match(/-?\d*\.?\d+/g)?.map(Number);
  if (!nums || nums.length < 3) return null;
  let [r, g, b] = nums;
  if (/^color\(/i.test(css.trim())) [r, g, b] = [r * 255, g * 255, b * 255];
  const lin = (c: number) => {
    const v = Math.min(255, Math.max(0, c)) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.4 ? "dark" : "light"; // light text => dark theme
}

// ---- Free-plan limit view (from the message_limit hint seen in completion streams) ----

export type LimitStatus = "within" | "approaching" | "exceeded";
export interface LimitWindowView {
  name: string; // "5h" | "7d" | raw name
  pct: number | null; // 0–100
  resetsAt: string | null; // ISO
}
export interface FreeLimitView {
  status: LimitStatus | null;
  remaining: number | null;
  resetsAt: string | null; // ISO
  windows: LimitWindowView[];
}

export const HINT_MAX_AGE_MS = 6 * 3600_000;
const EMPTY_VIEW = (): FreeLimitView => ({ status: null, remaining: null, resetsAt: null, windows: [] });

/** Epoch seconds, epoch ms, numeric string or ISO string -> ISO string; null when unusable. */
export function toIso(v: unknown): string | null {
  let ms: number | null = null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      ms = n < 1e11 ? n * 1000 : n;
    } else {
      const p = Date.parse(t);
      if (Number.isFinite(p)) ms = p;
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}

function toStatus(v: unknown): LimitStatus | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (/exceed|reached|blocked|reject|denied/.test(s)) return "exceeded";
  if (/approach|warn|near/.test(s)) return "approaching";
  if (/within|allowed|^ok$|normal|available/.test(s)) return "within";
  return null;
}

/** 0–1 fractions and 0–100 percentages both -> 0–100 (a value <= 1 is a fraction). */
function toPct(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return clampPct(v <= 1 ? v * 100 : v);
}

function windowName(raw: string): string {
  const s = raw.toLowerCase().replace(/[\s-]/g, "_");
  if (s === "5h" || s === "five_hour" || s === "5_hour" || s === "session") return "5h";
  if (s === "7d" || s === "seven_day" || s === "7_day" || s === "weekly" || s === "week") return "7d";
  return raw;
}

/**
 * Normalises a LimitHint (dotted keys) for display. All fields optional; anything stale (older than 6 h, or whose
 * reset time has passed) is dropped, so a fully stale hint yields an empty view.
 */
export function freeLimitView(hint: { ts: number; fields: Record<string, string | number | boolean> } | null | undefined, now: number): FreeLimitView {
  if (!hint || !hint.fields || typeof hint.ts !== "number" || !(now - hint.ts < HINT_MAX_AGE_MS)) return EMPTY_VIEW();
  const f = hint.fields;
  const first = (...keys: string[]): unknown => {
    for (const k of keys) if (k in f) return f[k];
    return undefined;
  };
  const alive = (iso: string | null): boolean => iso === null || Date.parse(iso) > now;

  const wins = new Map<string, { util?: unknown; status?: unknown; reset?: unknown }>();
  for (const [k, v] of Object.entries(f)) {
    const m = /(?:^|\.)windows\.([^.]+)\.(utilization|status|resets_?[aA]t)$/.exec(k);
    if (!m) continue;
    const w = wins.get(m[1]) ?? {};
    if (m[2] === "utilization") w.util = v;
    else if (m[2] === "status") w.status = v;
    else w.reset = v;
    wins.set(m[1], w);
  }
  const windows: LimitWindowView[] = [];
  let worst: LimitStatus | null = null;
  const rank: Record<LimitStatus, number> = { within: 0, approaching: 1, exceeded: 2 };
  for (const [raw, w] of wins) {
    const resetsAt = toIso(w.reset);
    if (!alive(resetsAt)) continue;
    const st = toStatus(w.status);
    if (st && (!worst || rank[st] > rank[worst])) worst = st;
    windows.push({ name: windowName(raw), pct: toPct(w.util), resetsAt });
  }
  const order = (n: string) => (n === "5h" ? 0 : n === "7d" ? 1 : 2);
  windows.sort((a, b) => order(a.name) - order(b.name));

  const resetsAt = toIso(first("message_limit.resetsAt", "message_limit.resets_at", "resetsAt", "resets_at"));
  const view: FreeLimitView = { status: null, remaining: null, resetsAt, windows };
  if (!alive(resetsAt)) {
    view.resetsAt = null;
    return view; // top-level limit already reset: status/remaining no longer apply
  }
  view.status = toStatus(first("message_limit.type", "message_limit.status", "status")) ?? worst;
  const rem = first("message_limit.remaining", "remaining");
  view.remaining = typeof rem === "number" && Number.isFinite(rem) && rem >= 0 ? Math.floor(rem) : null;
  return view;
}

/** Row value text for the Free limit line. */
export function freeLimitText(v: FreeLimitView): string {
  if (v.status === "exceeded") return "Limit reached";
  // Amber tone already says "approaching"; short text keeps the row on one line.
  if (v.status === "approaching") return v.remaining !== null ? `${v.remaining} ${v.remaining === 1 ? "msg" : "msgs"} left` : "Approaching limit";
  return "Within limit";
}

export const PLAN_NAMES: Record<string, string> = { free: "Free", pro: "Pro", max: "Max", team: "Team" };

// ---- model rows (neutral: counts + tokens, never the blue limit %) ----

export interface ModelRowView {
  label: string; // "Sonnet 5.5:"
  mid: string; // "14 msgs"
  right: string; // "≈6.1k tok"
  title: string; // tooltip
  share: number; // 0–100 bar width (share of tokens)
}

export function modelRowView(m: ModelShare, estimated: boolean, scope = "this device's"): ModelRowView {
  const msgs = `${m.messages} ${m.messages === 1 ? "msg" : "msgs"}`;
  const tok = `${estimated ? "≈" : ""}${formatTokens(m.tokens)} tok`;
  const of = m.tokens > 0 ? "tokens" : "messages";
  return { label: `${m.label}:`, mid: msgs, right: tok, title: `${m.label} · ${m.pct}% of ${scope} ${of} · ${msgs} · ${tok}`, share: m.pct };
}

// ---- plan rows (Session / Weekly), shared by Free and Pro/Max-style layout ----

export interface PlanRow {
  key: "five_hour" | "seven_day";
  label: string;
  kind: "pct" | "text" | "none";
  pct: number; // kind "pct"
  text: string; // kind "text" ("—" for none)
  tone: Tone;
  resetsAt: string | null;
}
export interface PlanRowsView {
  rows: PlanRow[];
  hint: string | null;
}

export const PLAN_ROW_LABELS = { five_hour: "Session (5h):", seven_day: "Weekly:" } as const;

/** Free-plan (or unknown plan without account usage) Session + Weekly rows. Order: account usage -> limit hint -> "—". */
export function planRows(
  acct: { windows: AccountWindow[] } | null | undefined,
  hint: { ts: number; fields: Record<string, string | number | boolean> } | null | undefined,
  _plan: string | null | undefined,
  now: number,
): PlanRowsView {
  const v = freeLimitView(hint, now);
  const keys = ["five_hour", "seven_day"] as const;
  const hintName = { five_hour: "5h", seven_day: "7d" } as const;
  const rows: PlanRow[] = keys.map((key) => {
    const base = { key, label: PLAN_ROW_LABELS[key], pct: 0, text: "—", tone: "ok" as Tone, resetsAt: null as string | null };
    const a = acct?.windows?.find((w) => w.name === key);
    if (a && Number.isFinite(a.utilization)) {
      const pct = clampPct(a.utilization);
      return { ...base, kind: "pct", pct, tone: sbTone(pct), resetsAt: a.resetsAt ?? null };
    }
    const hw = v.windows.find((w) => w.name === hintName[key] && w.pct !== null);
    if (hw) {
      const pct = clampPct(hw.pct ?? 0);
      return { ...base, kind: "pct", pct, tone: sbTone(pct), resetsAt: hw.resetsAt };
    }
    return { ...base, kind: "none" };
  });
  const session = rows[0];
  if (session.kind === "none" && v.status) {
    session.kind = "text";
    session.text = freeLimitText(v);
    session.tone = v.status === "exceeded" ? "bad" : v.status === "approaching" ? "warn" : "ok";
    session.resetsAt = v.resetsAt;
  }
  const allNone = rows.every((r) => r.kind === "none");
  return { rows, hint: allNone ? "Updates after your next message" : null };
}

// ---- per-model limit attribution rows (percentage points of the 5h / weekly limits) ----

/** "52%", "<1%" for 0 < x < 0.5, "0%" for nothing. */
export function formatPoints(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return "0%";
  if (x < 0.5) return "<1%";
  return `${Math.round(x)}%`;
}

export interface AttrRowView {
  label: string; // "Opus 4.5:"
  p5: number;
  pw: number;
  five: string;
  week: string;
  tokens: string; // "≈6.1k", "" when none
  title: string;
  bar: number; // 0–100 (5h points)
}

export interface AttrView {
  rows: AttrRowView[];
  other: AttrRowView;
}

const EXPLAIN = "≈ attributed from changes in your plan usage after each reply";

/**
 * Merges models (by pretty label, so dated ids collapse), sorts by 5h points desc.
 * `tokens` = last-5h tokens per raw model id. Models with no points and no tokens are dropped.
 */
export function attributionRows(
  five: { byModel: Record<string, number>; other: number } | undefined,
  week: { byModel: Record<string, number>; other: number } | undefined,
  tokens: Record<string, number>,
  estimated: boolean,
): AttrView {
  const acc = new Map<string, { p5: number; pw: number; tk: number }>();
  const slot = (id: string) => {
    const label = prettyModel(id);
    let s = acc.get(label);
    if (!s) acc.set(label, (s = { p5: 0, pw: 0, tk: 0 }));
    return s;
  };
  for (const [m, v] of Object.entries(five?.byModel ?? {})) slot(m).p5 += v;
  for (const [m, v] of Object.entries(week?.byModel ?? {})) slot(m).pw += v;
  for (const [m, v] of Object.entries(tokens)) if (v > 0) slot(m).tk += v;
  const mk = (label: string, p5: number, pw: number, tk: number, extra: string): AttrRowView => ({
    label: `${label}:`,
    p5,
    pw,
    five: formatPoints(p5),
    week: formatPoints(pw),
    tokens: tk > 0 ? `${estimated ? "≈" : ""}${formatTokens(tk)}` : "",
    title: `${label} · ${formatPoints(p5)} of the 5h limit · ${formatPoints(pw)} of the weekly limit${tk > 0 ? ` · ${estimated ? "≈" : ""}${formatTokens(tk)} tokens in the last 5h` : ""}. ${extra}${EXPLAIN}`,
    bar: clampPct(p5),
  });
  const rows = [...acc.entries()]
    .filter(([, s]) => s.p5 > 0 || s.pw > 0 || s.tk > 0)
    .sort((a, b) => b[1].p5 - a[1].p5 || b[1].pw - a[1].pw || b[1].tk - a[1].tk || a[0].localeCompare(b[0]))
    .map(([label, s]) => mk(label, s.p5, s.pw, s.tk, ""));
  const other = mk("Other", five?.other ?? 0, week?.other ?? 0, 0, "Other devices, mobile, and usage from before tracking started. ");
  other.title = `Other · ${other.five} of the 5h limit · ${other.week} of the weekly limit. Other devices, mobile, and usage from before tracking started. ${EXPLAIN}`;
  return { rows, other };
}

// ---- per-device plan-limit points (Devices view) ----

export interface DeviceRowView {
  key: string;
  label: string;
  pts: string; // "9.0 pts"
  share: string; // "56%"
  bar: number; // 0-100
  badge: "High" | "Medium" | "Low" | null; // null for the Unattributed row
  title: string;
  unattributed: boolean;
  /** muted explanation under the row (waiting for the % to move / nothing yet), else null */
  note: string | null;
}

export interface DeviceSectionView {
  name: "five_hour" | "seven_day";
  heading: string; // "5-hour" | "Weekly"
  resetsAt: string | null;
  total: string; // "Total 15.0 pts"
  since: string | null; // "Tracking since 10:42"
  rows: DeviceRowView[];
}

export type DevicesPanelView = { kind: "empty"; message: string } | { kind: "ok"; sections: DeviceSectionView[] };

export const DEVICES_UNATTRIBUTED_MIN = 0.05;
export const DEVICES_FOOTER = "Estimates. Anthropic does not publish per-device usage.";
const CONFIDENCE_TITLE = {
  High: "High: only this device was active when usage rose.",
  Medium: "Medium: only a sessions-list change (no direct count) showed this device was active.",
  Low: "Low: several devices were active, so the rise was split by estimated cost.",
} as const;
const UNATTRIBUTED_TITLE = "Usage no device could be matched to: devices whose Updated time didn't change, and usage from before tracking started.";
export const WAITING_NOTE = "Waiting for the usage % to move";
export const NO_LOCAL_USAGE_NOTE = "No usage from this browser yet in this window";

/** "Tracking since 10:42" (local time); with the date when it was not today. */
export function formatTrackingSince(ts: number | undefined, now: number): string | null {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return `Tracking since ${sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`}`;
}

const fmtPts = (x: number): string => `${(Number.isFinite(x) && x > 0 ? x : 0).toFixed(1)} pts`;
const sharePct = (pts: number, total: number): number => (total > 0 ? clampPct((pts / total) * 100) : 0);

/** Display rows for one window: one per device (already sorted by the engine), then "Unattributed" when >= 0.05 pts. */
export function deviceRowsFor(view: DeviceWindowView): DeviceRowView[] {
  const rows: DeviceRowView[] = view.rows.map((r) => {
    const badge = r.confidence === "low" ? "Low" : r.confidence === "medium" ? "Medium" : "High";
    const share = sharePct(r.pts, view.totalPts);
    return { key: r.key, label: r.label, pts: fmtPts(r.pts), share: `${Math.round(share)}%`, bar: share, badge, title: `${r.label} · ${fmtPts(r.pts)} · ${CONFIDENCE_TITLE[badge]}`, unattributed: false, note: r.waiting ? WAITING_NOTE : r.key === "local" && !(r.pts >= DEVICES_UNATTRIBUTED_MIN) ? NO_LOCAL_USAGE_NOTE : null };
  });
  if (view.unattributedPts >= DEVICES_UNATTRIBUTED_MIN) {
    const share = sharePct(view.unattributedPts, view.totalPts);
    rows.push({ key: "unattributed", label: "Unattributed", pts: fmtPts(view.unattributedPts), share: `${Math.round(share)}%`, bar: share, badge: null, title: UNATTRIBUTED_TITLE, unattributed: true, note: null });
  }
  return rows;
}

/** Everything the Devices tab renders (or the empty-state message). Never throws on partial data. */
export function devicesPanel(
  devices: DeviceView | undefined,
  acct: { windows: AccountWindow[] } | null | undefined,
  plan: string | null | undefined,
  now: number = Date.now(),
): DevicesPanelView {
  const sections: DeviceSectionView[] = [];
  for (const [name, heading] of [["five_hour", "5-hour"], ["seven_day", "Weekly"]] as const) {
    const v = devices?.[name];
    if (!v) continue;
    const resetsAt = acct?.windows?.find((w) => w.name === name)?.resetsAt ?? (Number.isFinite(Date.parse(v.cycle)) ? v.cycle : null);
    sections.push({ name, heading, resetsAt, total: `Total ${fmtPts(v.totalPts)}`, since: formatTrackingSince(v.trackingSince, now), rows: deviceRowsFor(v) });
  }
  if (sections.length) return { kind: "ok", sections };
  if (plan === "free" && !acct?.windows?.length) return { kind: "empty", message: "Per-device usage needs a Pro/Max plan usage reading." };
  return { kind: "empty", message: "Waiting for your plan usage reading…" };
}
