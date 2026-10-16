/** k / M / B formatting for token counts. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  const f = (v: number, s: string) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, "") + s;
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "k");
  return String(Math.round(n));
}

const NAMES: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "Weekly (all models)",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
};

export function humanizeWindow(name: string): string {
  if (NAMES[name]) return NAMES[name];
  return name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

function span(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 1) return "<1m";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function resetsIn(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  return t <= now ? "resetting now" : `resets in ${span(t - now)}`;
}

export function ago(ts: number, now: number): string {
  const ms = now - ts;
  if (ms < 60000) return "just now";
  return `${span(ms)} ago`;
}
