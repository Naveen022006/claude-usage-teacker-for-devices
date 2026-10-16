import { describe, expect, it } from "vitest";
import { createDesktopLimitsSource, NOTE_DESKTOP_NO_LIMITS } from "../src/server/desktopLimits";
import { buildTrayState } from "../src/server/trayState";

describe("Claude Desktop only (no Chrome, no CLI, no logins)", () => {
  it("plan limits source never reads credentials and says limits aren't shared", async () => {
    const src = createDesktopLimitsSource();
    expect(await src.poll()).toEqual({ kind: "none", note: NOTE_DESKTOP_NO_LIMITS });
    expect(src.inspect().accountKind).toBe("desktop");
  });

  it("without plan limits, models show exact Desktop tokens per 5h / week and replies — no %", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const s = buildTrayState({
      now,
      plan: null,
      limitsSource: null,
      limitsNote: NOTE_DESKTOP_NO_LIMITS,
      accountUsage: null,
      // stale attribution from an earlier source must not leak into the rows
      attribution: { five_hour: { byModel: { "claude-opus-5-5": 91 }, other: 0 }, seven_day: { byModel: { "claude-opus-5-5": 13 }, other: 0 } },
      tokensNew5hByModel: { "claude-opus-5-5": 1200 },
      usage5hByModel: { "claude-opus-5-5": { tokens: 1200, messages: 3 } },
      usage7dByModel: { "claude-opus-5-5": { tokens: 48_000, messages: 40 }, "claude-sonnet-5-5": { tokens: 12_000, messages: 9 } },
      accountKind: "desktop",
    });
    expect(s.modelHeader).toEqual(["5h tok", "Week tok", "Replies"]);
    expect(s.models.map((m) => [m.label, m.text5h, m.textWeek, m.tokensText, m.pct5h, m.pctWeek, m.barPct])).toEqual([
      ["Opus 5.5", "1.2k", "48k", "40", null, null, 100],
      ["Sonnet 5.5", "—", "12k", "9", null, null, 25],
    ]);
    expect(s.other).toBeNull();
    expect(s.limits.every((l) => l.pct === null)).toBe(true);
    expect(s.limitsNote).toBe(NOTE_DESKTOP_NO_LIMITS);
    expect(s.tooltip).toBe("Claude Desktop · 5h 1.2k tok · week 60k tok");
    expect(s.iconPct).toBeNull();
  });
});
