// Pure builder for GET /u/<key>/api/tray (contract: ../shared/tray.ts).
import type { AccountUsage, Plan } from "../../../src/shared/types";
import type { AttributionView } from "../../../src/shared/attribution";
import { NOTE_CLI } from "./accountUsage";
import { formatTokens, prettyModel, sbTone } from "../../../src/widget/helpers";
import type { TrayLimit, TrayModel, TrayState } from "../shared/tray";

export interface TrayInput {
  now: number;
  plan: Plan | null;
  limitsSource: TrayState["limitsSource"];
  limitsNote: string | null;
  accountUsage: AccountUsage | null;
  attribution: AttributionView;
  /** NEW tokens (cache reads excluded) per model id, last 5 h. */
  tokensNew5hByModel: Record<string, number>;
  /** Epoch ms until which account polling is backed off (rate limit / errors); null = not backing off. */
  backoffUntil?: number | null;
  accountKind?: "tray" | "cli" | "desktop" | null;
}

export const STALE_AFTER_MS = 10 * 60_000;
const NOTE_RATE_LIMIT = "Anthropic rate limit";

/** One short line: error note (+ remaining backoff for rate limits) and/or reading age when stale. */
export function composeLimitsNote(i: Pick<TrayInput, "now" | "limitsNote" | "accountUsage" | "backoffUntil">): string | null {
  let note = i.limitsNote;
  const left = i.backoffUntil && i.backoffUntil > i.now ? i.backoffUntil - i.now : 0;
  if (note === NOTE_RATE_LIMIT && left > 0) note = `${note} — retrying in ${Math.max(1, Math.ceil(left / 60_000))}m`;
  const age = i.accountUsage ? i.now - i.accountUsage.fetchedAt : 0;
  if (i.accountUsage && age > STALE_AFTER_MS) {
    const ago = shortCountdown(age);
    note = note ? `${note} · ${ago} old` : `Updated ${ago} ago`;
  }
  return note;
}

/** CLI-fallback hint goes after any error/age note. */
export function withAccountNote(note: string | null, kind: "tray" | "cli" | "desktop" | null): string | null {
  if (kind !== "cli") return note;
  return note ? `${note} · ${NOTE_CLI}` : NOTE_CLI;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** "3h 5m", "12m", "6d 16h", "<1m". */
export function shortCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const m = Math.floor(ms / 60_000) % 60;
  const h = Math.floor(ms / 3_600_000) % 24;
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

const LIMIT_DEFS: { name: string; label: string; always: boolean }[] = [
  { name: "five_hour", label: "Session (5h)", always: true },
  { name: "seven_day", label: "Weekly", always: true },
  { name: "seven_day_opus", label: "Weekly Opus", always: false },
  { name: "seven_day_sonnet", label: "Weekly Sonnet", always: false },
];

export function buildTrayState(i: TrayInput): TrayState {
  const limits: TrayLimit[] = [];
  for (const d of LIMIT_DEFS) {
    const w = i.accountUsage?.windows.find((x) => x.name === d.name);
    if (!w && !d.always) continue;
    const pct = w ? Math.min(100, Math.max(0, r1(w.utilization))) : null;
    limits.push({ label: d.label, pct, resetsAt: w?.resetsAt ?? null, tone: pct === null ? "ok" : sbTone(pct) });
  }

  // Per-model % only make sense next to a current plan reading; without one, show tokens only.
  const hasLimits = !!i.accountUsage?.windows.length;
  const a5 = hasLimits ? i.attribution.five_hour : undefined;
  const aw = hasLimits ? i.attribution.seven_day : undefined;
  const ids = new Set<string>([...Object.keys(a5?.byModel ?? {}), ...Object.keys(aw?.byModel ?? {}), ...Object.keys(i.tokensNew5hByModel)]);
  const models: TrayModel[] = [];
  for (const id of ids) {
    const tokens = Math.max(0, Math.round(i.tokensNew5hByModel[id] ?? 0));
    const p5 = a5 ? a5.byModel[id] : undefined;
    const pw = aw ? aw.byModel[id] : undefined;
    if (!tokens && !p5 && !pw) continue;
    models.push({ label: prettyModel(id), pct5h: p5 === undefined ? null : r1(p5), pctWeek: pw === undefined ? null : r1(pw), tokens, tokensText: formatTokens(tokens) });
  }
  models.sort((a, b) => (b.pct5h ?? -1) - (a.pct5h ?? -1) || b.tokens - a.tokens);

  const other = a5 || aw ? { pct5h: a5 ? r1(a5.other) : null, pctWeek: aw ? r1(aw.other) : null } : null;

  const session = limits[0];
  const weekly = limits[1];
  let tooltip: string;
  if (session.pct === null && weekly.pct === null) tooltip = "Claude usage · plan limits unavailable";
  else {
    const parts = ["Claude"];
    if (session.pct !== null) {
      const ms = session.resetsAt ? Date.parse(session.resetsAt) - i.now : NaN;
      parts.push(`Session ${Math.round(session.pct)}%${Number.isFinite(ms) ? ` (${shortCountdown(ms)})` : ""}`);
    }
    if (weekly.pct !== null) parts.push(`Weekly ${Math.round(weekly.pct)}%`);
    tooltip = parts.join(" · ");
  }
  if (tooltip.length > 127) tooltip = tooltip.slice(0, 126) + "…";

  const iconPct = session.pct === null ? null : Math.round(session.pct);
  return {
    ok: true,
    updatedAt: i.now,
    plan: i.plan,
    limitsSource: i.limitsSource,
    limitsNote: withAccountNote(composeLimitsNote(i), i.accountKind ?? null),
    accountKind: i.accountKind ?? null,
    limits,
    models: models.slice(0, 6),
    other,
    modelsEstimated: !!(a5?.baselineEstimated || aw?.baselineEstimated),
    tooltip,
    iconPct,
    iconTone: iconPct === null ? "ok" : sbTone(iconPct),
  };
}
