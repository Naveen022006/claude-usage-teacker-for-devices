import { describe, expect, it } from "vitest";
import type { DesktopState } from "../src/shared/ipc";
import { SIGN_IN_HINT, buildView, countdownText, footerText, planFooterText, modelsView, planRowViews } from "../src/renderer/view";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const agg = (byModel: Record<string, { messages: number; tokens: number }>) => ({ messages: 0, promptTokens: 0, outputTokens: 0, byModel });
const aggs = (b: Record<string, { messages: number; tokens: number }>) => ({ today: agg({}), last5h: agg(b), last7d: agg({}) });

function state(over: Partial<DesktopState> = {}): DesktopState {
  return {
    now: NOW,
    auth: { state: "signed-in" },
    plan: "pro",
    accountUsage: { fetchedAt: NOW, windows: [
      { name: "seven_day", utilization: 11, resetsAt: iso(6 * 86400_000) },
      { name: "five_hour", utilization: 79, resetsAt: iso(3 * 3600_000 + 5 * 60_000) },
    ] },
    attribution: {
      five_hour: { byModel: { "claude-opus-5-5": 52, "claude-sonnet-5-5": 19 }, other: 8 },
      seven_day: { byModel: { "claude-opus-5-5": 7, "claude-sonnet-5-5": 3 }, other: 1 },
    },
    local: [
      { source: "claude-code", aggregates: aggs({ "claude-opus-5-5": { messages: 2, tokens: 1000 } }) },
      { source: "desktop", aggregates: aggs({ "claude-opus-5-5": { messages: 1, tokens: 500 }, "claude-sonnet-5-5": { messages: 3, tokens: 2500 } }) },
    ],
    tokens5hByModel: { "claude-opus-5-5": 48000, "claude-sonnet-5-5": 21000 },
    scan: { lastScanAt: NOW - 12_000, filesRead: 3 },
    ui: { alwaysOnTop: true, collapsed: false },
    ...over,
  };
}

describe("plan rows", () => {
  it("orders session before weekly with tones", () => {
    const { rows } = planRowViews(state(), NOW);
    expect(rows.map((r) => r.label)).toEqual(["Session (5h):", "Weekly:"]);
    expect(rows[0]).toMatchObject({ kind: "pct", pct: 79, tone: "ok" });
  });
  it("tones: amber >= 80, red >= 95", () => {
    const s = state({ accountUsage: { fetchedAt: NOW, windows: [{ name: "five_hour", utilization: 96 }, { name: "seven_day", utilization: 85 }] } });
    expect(planRowViews(s, NOW).rows.map((r) => r.tone)).toEqual(["bad", "warn"]);
  });
  it("signed out shows dashes and the sign-in hint", () => {
    const v = planRowViews(state({ auth: { state: "signed-out" }, plan: null, accountUsage: null }), NOW);
    expect(v.rows.map((r) => r.kind)).toEqual(["none", "none"]);
    expect(v.hint).toBe(SIGN_IN_HINT);
  });
});

describe("models", () => {
  it("attribution rows with exact tokens and Other row", () => {
    const m = modelsView(state());
    expect(m.mode).toBe("attr");
    expect(m.attr[0]).toMatchObject({ label: "Opus 5.5:", five: "52%", week: "7%", tokens: "48k" });
    expect(m.other?.five).toBe("8%");
  });
  it("falls back to combined local msgs + tokens without account usage", () => {
    const m = modelsView(state({ accountUsage: null, plan: null, auth: { state: "signed-out" } }));
    expect(m.mode).toBe("local");
    expect(m.local[0]).toMatchObject({ label: "Sonnet 5.5:", mid: "3 msgs", right: "2.5k tok" });
    expect(m.local[1]).toMatchObject({ label: "Opus 5.5:", mid: "3 msgs", right: "1.5k tok" });
  });
});

describe("view", () => {
  it("builds footer and flags", () => {
    expect(footerText(state(), NOW)).toBe("Local: Claude Code · Desktop · updated 12s ago");
    expect(planFooterText(state(), NOW)).toBe("Plan limits via hub · updated 0s ago");
    const v = buildView(state(), NOW);
    expect(v.signedIn).toBe(true);
    expect(v.planName).toBe("Pro");
    expect(v.error).toBeNull();
  });
  it("countdown with seconds", () => {
    expect(countdownText(iso(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m 00s");
    expect(countdownText(null, NOW)).toBe("");
  });
});
