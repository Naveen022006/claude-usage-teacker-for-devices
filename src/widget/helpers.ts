// Pure helpers for the in-page widget (tested in test/widget.test.ts). No DOM, no chrome.*.

import type { HubDevice } from "../shared/messages";
import type { AccountWindow, Aggregates, Source, WindowAggregate, WindowName } from "../shared/types";

export type TabId = "session" | "today" | "week";
export const TABS: { id: TabId; label: string; window: WindowName }[] = [
  { id: "session", label: "Session (5h)", window: "last5h" },
  { id: "today", label: "Today", window: "today" },
  { id: "week", label: "7 days", window: "last7d" },
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

/** "2h 14m", "14m", "3d 4h", "now"; "" if unknown/invalid. */
export function formatCountdown(iso: string | undefined, now: number): string {
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
