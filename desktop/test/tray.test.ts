import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTrayState } from "../src/server/trayState";

let tmp: string;

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "um-tray-")); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildTrayState", () => {
  const now = Date.parse("2030-01-01T01:55:00Z");
  const usage = { fetchedAt: now, windows: [{ name: "five_hour", utilization: 42.4, resetsAt: "2030-01-01T05:00:00Z" }, { name: "seven_day", utilization: 11 }] };
  it("builds limits, models, tooltip and icon", () => {
    const s = buildTrayState({
      now, plan: "max", limitsSource: "account", limitsNote: null, accountUsage: usage,
      attribution: { five_hour: { byModel: { "claude-opus-5-5": 30.04, "claude-sonnet-5-5": 12 }, other: 0.4 }, seven_day: { byModel: { "claude-opus-5-5": 8 }, other: 1 } },
      tokensNew5hByModel: { "claude-sonnet-5-5": 48_000, "claude-haiku-4-5": 1200 },
    });
    expect(s.limits.map((l) => l.label)).toEqual(["Session (5h)", "Weekly"]);
    expect(s.limits[0]).toMatchObject({ pct: 42.4, tone: "ok" });
    expect(s.models.map((m) => m.label)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]);
    expect(s.models[0]).toMatchObject({ pct5h: 30, pctWeek: 8, tokens: 0 });
    expect(s.models[1]).toMatchObject({ tokensText: "48k", pctWeek: null });
    expect(s.other).toEqual({ pct5h: 0.4, pctWeek: 1 });
    expect(s.tooltip).toBe("Claude · Session 42% (3h 5m) · Weekly 11%");
    expect(s.iconPct).toBe(42);
    expect(s.iconTone).toBe("ok");
  });
  it("unknown limits", () => {
    const s = buildTrayState({ now, plan: null, limitsSource: null, limitsNote: "Waiting for Claude Desktop", accountUsage: null, attribution: {}, tokensNew5hByModel: {} });
    expect(s.limits.map((l) => [l.label, l.pct])).toEqual([["Session (5h)", null], ["Weekly", null]]);
    expect(s.tooltip).toBe("Claude usage · plan limits unavailable");
    expect(s.iconPct).toBeNull();
    expect(s.other).toBeNull();
  });
  it("caps models at 6, tone warn/bad, tooltip <= 127", () => {
    const tokens: Record<string, number> = {};
    for (let i = 0; i < 9; i++) tokens[`claude-model${i}-1`] = i + 1;
    const s = buildTrayState({ now, plan: "pro", limitsSource: "hub", limitsNote: null, accountUsage: { fetchedAt: now, windows: [{ name: "five_hour", utilization: 96 }, { name: "seven_day", utilization: 85 }, { name: "seven_day_opus", utilization: 5 }] }, attribution: {}, tokensNew5hByModel: tokens });
    expect(s.models).toHaveLength(6);
    expect(s.limits.map((l) => l.tone)).toEqual(["bad", "warn", "ok"]);
    expect(s.limits[2].label).toBe("Weekly Opus");
    expect(s.tooltip.length).toBeLessThanOrEqual(127);
  });
});

