// Pure view-model assembly for the companion window (no DOM). Tested in desktop/test/renderer.test.ts.
import type { DesktopState } from "../shared/ipc";
import type { WindowAggregate } from "../../../src/shared/types";
import {
  PLAN_NAMES, attributionRows, clampPct, formatAgo, formatCountdown, humanizeWindow, modelRowView, modelShares,
  msUntil, planRows, sbTone, sortWindows, type AttrRowView, type ModelRowView, type Tone,
} from "../../../src/widget/helpers";

export const MAX_MODEL_ROWS = 6;
export const SIGN_IN_HINT = "Connect your Usage Hub (Chrome extension or daemon config) to see plan limits";

const LABELS: Record<string, string> = {
  five_hour: "Session (5h):",
  seven_day: "Weekly:",
  seven_day_opus: "Weekly Opus:",
  seven_day_sonnet: "Weekly Sonnet:",
};

export interface PlanRowView {
  label: string;
  kind: "pct" | "text" | "none";
  pct: number;
  text: string;
  tone: Tone;
  resetsAt: string | null;
}

export interface ModelsView {
  mode: "attr" | "local";
  attr: AttrRowView[];
  other: AttrRowView | null;
  local: ModelRowView[];
  more: number;
}

export interface View {
  planName: string | null;
  signedIn: boolean;
  signingIn: boolean;
  rows: PlanRowView[];
  hint: string | null;
  models: ModelsView;
  footer: string;
  planFooter: string;
  error: string | null;
}

export function planRowViews(s: DesktopState, now: number): { rows: PlanRowView[]; hint: string | null } {
  const ws = sortWindows(s.accountUsage?.windows ?? []);
  const known = ws.filter((w) => LABELS[w.name]);
  if (s.plan !== "free" && known.length) {
    return {
      rows: known.map((w) => {
        const pct = clampPct(w.utilization);
        return { label: LABELS[w.name] ?? `${humanizeWindow(w.name)}:`, kind: "pct" as const, pct, text: "", tone: sbTone(pct), resetsAt: w.resetsAt ?? null };
      }),
      hint: null,
    };
  }
  const v = planRows(s.accountUsage, null, s.plan, now);
  const rows: PlanRowView[] = v.rows.map((r) => ({ label: r.label, kind: r.kind, pct: r.pct, text: r.text, tone: r.tone, resetsAt: r.resetsAt }));
  const signedOut = s.auth.state !== "signed-in";
  return { rows, hint: v.hint ? (signedOut ? SIGN_IN_HINT : v.hint) : null };
}

export function localByModel5h(s: DesktopState): WindowAggregate["byModel"] {
  const out: WindowAggregate["byModel"] = {};
  for (const l of s.local) {
    for (const [m, v] of Object.entries(l.aggregates?.last5h?.byModel ?? {})) {
      const cur = out[m] ?? { messages: 0, tokens: 0 };
      out[m] = { messages: cur.messages + (v?.messages || 0), tokens: cur.tokens + (v?.tokens || 0) };
    }
  }
  return out;
}

export function modelsView(s: DesktopState): ModelsView {
  const ws = s.accountUsage?.windows ?? [];
  const attributed = s.plan !== "free" && ws.some((w) => w.name === "five_hour" || w.name === "seven_day");
  if (attributed) {
    const v = attributionRows(s.attribution?.five_hour, s.attribution?.seven_day, s.tokens5hByModel ?? {}, false);
    return { mode: "attr", attr: v.rows.slice(0, MAX_MODEL_ROWS), other: v.other, local: [], more: Math.max(0, v.rows.length - MAX_MODEL_ROWS) };
  }
  const shares = modelShares(localByModel5h(s));
  return { mode: "local", attr: [], other: null, local: shares.slice(0, MAX_MODEL_ROWS).map((m) => modelRowView(m, false, "local")), more: Math.max(0, shares.length - MAX_MODEL_ROWS) };
}

export function footerText(s: DesktopState, now: number): string {
  const names = s.local.map((l) => (l.source === "claude-code" ? "Claude Code" : "Desktop"));
  const src = names.length ? names.join(" · ") : "no sources";
  return `Local: ${src} · updated ${formatAgo(s.scan.lastScanAt, now)}`;
}

export function planFooterText(s: DesktopState, now: number): string {
  return s.accountUsage ? `Plan limits via hub · updated ${formatAgo(s.accountUsage.fetchedAt, now)}` : "";
}

export function buildView(s: DesktopState, now: number): View {
  const { rows, hint } = planRowViews(s, now);
  return {
    planName: s.plan ? (PLAN_NAMES[s.plan] ?? s.plan) : null,
    signedIn: s.auth.state === "signed-in",
    signingIn: s.auth.state === "signing-in",
    rows,
    hint,
    models: modelsView(s),
    footer: footerText(s, now),
    planFooter: planFooterText(s, now),
    error: s.auth.state === "error" ? (s.auth.error ?? "Sign-in failed") : (s.scan.error ?? null),
  };
}

export function countdownText(iso: string | null | undefined, now: number): string {
  const ms = msUntil(iso ?? undefined, now);
  return ms === null ? "" : formatCountdown(ms);
}
