import { describe, expect, it } from "vitest";
import { parseAccountUsage, describeShape } from "../src/sync/accountUsage";
import { modelRowView, modelShares, planRows } from "../src/widget/helpers";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const SEC = Math.floor(NOW / 1000);
const R = "2026-10-16T15:00:00.000Z";
const hint = (fields: Record<string, string | number | boolean>) => ({ ts: NOW - 1000, fields });
const names = (j: unknown) => parseAccountUsage(j, NOW)?.windows.map((w) => [w.name, w.utilization]);

describe("parseAccountUsage variants", () => {
  it("flat Pro shape unchanged", () => {
    expect(parseAccountUsage({ five_hour: { utilization: 2, resets_at: R }, seven_day: { utilization: 0, resets_at: R } }, NOW)).toEqual({
      fetchedAt: NOW,
      windows: [{ name: "five_hour", utilization: 2, resetsAt: R }, { name: "seven_day", utilization: 0, resetsAt: R }],
    });
  });
  it("skips null windows / null utilization, null only if nothing usable", () => {
    expect(names({ five_hour: null, seven_day: { utilization: null }, seven_day_opus: { utilization: 5 } })).toEqual([["seven_day_opus", 5]]);
    expect(parseAccountUsage({ five_hour: null, seven_day: { utilization: null } }, NOW)).toBeNull();
  });
  it("nested windows object", () => {
    expect(names({ windows: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } } })).toEqual([["five_hour", 10], ["seven_day", 20]]);
  });
  it("rate_limits array with 5h / 7d names", () => {
    expect(names({ rate_limits: [{ window: "5h", utilization: 30, resets_at: R }, { window: "7d", utilization: 40 }] })).toEqual([["five_hour", 30], ["seven_day", 40]]);
  });
  it("limits list with kind / percent / scope.model", () => {
    const j = {
      five_hour: null,
      seven_day: null,
      limits: [
        { kind: "session", percent: 42, resets_at: R },
        { kind: "weekly_all", percent: 11, resets_at: R },
        { kind: "weekly_scoped", percent: 7, resets_at: R, scope: { model: { display_name: "Opus" } } },
        { kind: "weekly_scoped", percent: 3, scope: { model: { display_name: "Fable" } } },
      ],
    };
    expect(parseAccountUsage(j, NOW)?.windows).toEqual([
      { name: "five_hour", utilization: 42, resetsAt: R },
      { name: "seven_day", utilization: 11, resetsAt: R },
      { name: "seven_day_opus", utilization: 7, resetsAt: R },
      { name: "seven_day_fable", utilization: 3 },
    ]);
  });
  it("limits list wins over the older top-level fields; scoped limit without a model is skipped", () => {
    const j = {
      five_hour: { utilization: 99, resets_at: R },
      seven_day_sonnet: { utilization: 5 },
      limits: [{ kind: "session", percent: 40, id: "x1" }, { kind: "weekly_scoped", percent: 9, scope: {} }],
    };
    expect(names(j)).toEqual([["five_hour", 40], ["seven_day_sonnet", 5]]);
  });
  it("empty limits list (free plan) falls back to null", () => {
    expect(parseAccountUsage({ five_hour: null, seven_day: null, limits: [] }, NOW)).toBeNull();
  });
  it("0-1 fractions become percentages; 0-100 untouched", () => {
    expect(names({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 1 } })).toEqual([["five_hour", 42], ["seven_day", 100]]);
    expect(names({ five_hour: { utilization: 1 }, seven_day: { utilization: 55 } })).toEqual([["five_hour", 1], ["seven_day", 55]]);
  });
  it("never throws on junk", () => {
    for (const j of [null, undefined, 5, "x", [], [1, null], { a: 1 }, { windows: 3 }, { rate_limits: [null, 3, {}] }]) expect(() => parseAccountUsage(j, NOW)).not.toThrow();
    expect(parseAccountUsage(null)).toBeNull();
    expect(parseAccountUsage([])).toBeNull();
  });
  it("describeShape records keys and types but no values", () => {
    const s = describeShape({ five_hour: { utilization: 3, resets_at: "secret" }, x: null, rate_limits: [{ window: "5h" }] });
    expect(s).toEqual({ five_hour: { utilization: "number", resets_at: "string" }, x: "null", rate_limits: { "(array)": "array(1)", window: "string" } });
    expect(JSON.stringify(s)).not.toContain("secret");
  });
});

describe("planRows (Free)", () => {
  it("both none -> dashes and hint", () => {
    const v = planRows(null, null, "free", NOW);
    expect(v.rows.map((r) => [r.label, r.kind, r.text])).toEqual([["Session (5h):", "none", "—"], ["Weekly:", "none", "—"]]);
    expect(v.hint).toBe("Updates after your next message");
  });
  it("account usage wins over hint", () => {
    const v = planRows({ windows: [{ name: "five_hour", utilization: 12, resetsAt: R }] }, hint({ "message_limit.windows.5h.utilization": 0.9, "message_limit.windows.7d.utilization": 0.5 }), "free", NOW);
    expect(v.rows[0]).toMatchObject({ kind: "pct", pct: 12, resetsAt: R });
    expect(v.rows[1]).toMatchObject({ kind: "pct", pct: 50 });
    expect(v.hint).toBeNull();
  });
  it("hint windows fill rows with tone and reset", () => {
    const v = planRows(null, hint({ "message_limit.windows.5h.utilization": 0.42, "message_limit.windows.5h.resets_at": SEC + 3600, "message_limit.windows.7d.utilization": 0.86 }), "free", NOW);
    expect(v.rows[0]).toMatchObject({ kind: "pct", pct: 42, tone: "ok" });
    expect(v.rows[0].resetsAt).not.toBeNull();
    expect(v.rows[1]).toMatchObject({ kind: "pct", pct: 86, tone: "warn" });
  });
  it("status without windows becomes Session text", () => {
    const w = planRows(null, hint({ "message_limit.type": "within_limit" }), "free", NOW);
    expect(w.rows[0]).toMatchObject({ kind: "text", text: "Within limit", tone: "ok" });
    expect(w.rows[1].kind).toBe("none");
    expect(w.hint).toBeNull();
    const a = planRows(null, hint({ "message_limit.type": "approaching_limit", "message_limit.remaining": 3, "message_limit.resetsAt": SEC + 7200 }), "free", NOW);
    expect(a.rows[0]).toMatchObject({ kind: "text", text: "3 msgs left", tone: "warn" });
    expect(a.rows[0].resetsAt).not.toBeNull();
    const e = planRows(null, hint({ "message_limit.type": "exceeded_limit" }), "free", NOW);
    expect(e.rows[0]).toMatchObject({ text: "Limit reached", tone: "bad" });
  });
});

describe("modelRowView", () => {
  it("formats msgs, tokens and tooltip", () => {
    const one = modelShares({ "claude-sonnet-5-5": { messages: 1, tokens: 1200 } })[0];
    const v = modelRowView(one, true);
    expect(v).toMatchObject({ label: "Sonnet 5.5:", mid: "1 msg", right: "≈1.2k tok", share: 100 });
    const m = modelShares({ "claude-sonnet-5-5": { messages: 14, tokens: 6100 }, "claude-haiku-4-5": { messages: 5, tokens: 2700 } })[0];
    expect(modelRowView(m, true).title).toBe("Sonnet 5.5 · 69% of this device's tokens · 14 msgs · ≈6.1k tok");
    expect(modelRowView(m, false).right).toBe("6.1k tok");
  });
});
