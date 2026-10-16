import { describe, expect, it } from "vitest";
import {
  addContribution, applyReading, emptyLedger, modelFactor, normalizeLedger, recordHubSnapshot, replyWeight, type Ledger,
} from "../src/shared/attribution";
import { attributionRows, formatPoints } from "../src/widget/helpers";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const R5 = "2026-01-01T14:00:00Z";
const R7 = "2026-01-05T10:00:00Z";
const usage = (u5: number, u7: number, r5 = R5, r7 = R7) => ({
  windows: [
    { name: "five_hour", utilization: u5, resetsAt: r5 },
    { name: "seven_day", utilization: u7, resetsAt: r7 },
  ],
});
const sum = (l: Ledger, k: "five_hour" | "seven_day") => {
  const w = l.windows[k]!;
  return Object.values(w.byModel).reduce((a, b) => a + b, 0) + w.other;
};
const contrib = (model: string, weight: number, ts: number) => ({ model, weight, ts, source: "chrome" as const });

describe("weights", () => {
  it("model factors and reply weight", () => {
    expect(modelFactor("claude-opus-4-5")).toBe(5);
    expect(modelFactor("claude-sonnet-5-5")).toBe(1);
    expect(modelFactor("claude-haiku-4-5")).toBe(0.3);
    expect(modelFactor("mystery")).toBe(1);
    expect(replyWeight("claude-opus-4", 100, 10)).toBe(750);
  });
});

describe("applyReading", () => {
  it("initial utilisation goes to other", () => {
    const l = applyReading(emptyLedger(), usage(30, 10), T0);
    expect(l.windows.five_hour).toMatchObject({ other: 30, lastUtil: 30, byModel: {} });
    expect(l.windows.seven_day!.other).toBe(10);
  });

  it("single reply gets the whole delta", () => {
    let l = applyReading(emptyLedger(), usage(30, 10), T0);
    l = addContribution(l, contrib("opus", 10, T0 + 1000));
    l = applyReading(l, usage(35, 11), T0 + 5000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(5);
    expect(l.windows.seven_day!.byModel.opus).toBeCloseTo(1);
    expect(l.pendingW).toEqual({});
    expect(sum(l, "five_hour")).toBeCloseTo(35);
    expect(sum(l, "seven_day")).toBeCloseTo(11);
  });

  it("splits between several replies by weight", () => {
    let l = applyReading(emptyLedger(), usage(0, 0), T0);
    l = addContribution(l, contrib("opus", 30, T0 + 1000));
    l = addContribution(l, contrib("sonnet", 10, T0 + 2000));
    l = applyReading(l, usage(8, 0), T0 + 5000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(6);
    expect(l.windows.five_hour!.byModel.sonnet).toBeCloseTo(2);
  });

  it("no pending -> other", () => {
    let l = applyReading(emptyLedger(), usage(10, 1), T0);
    l = applyReading(l, usage(13, 1), T0 + 60_000);
    expect(l.windows.five_hour!.other).toBeCloseTo(13);
  });

  it("zero delta keeps the reply pending; the later rise goes to its model (the bug)", () => {
    let l = applyReading(emptyLedger(), usage(10, 5), T0);
    l = addContribution(l, contrib("opus", 10, T0 + 1000));
    l = applyReading(l, usage(10, 5), T0 + 5000); // server has not updated yet
    expect(l.pendingW.five_hour).toEqual({ opus: 10 });
    expect(l.pendingW.seven_day).toEqual({ opus: 10 });
    l = applyReading(l, usage(12, 7), T0 + 60_000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(2);
    expect(l.windows.seven_day!.byModel.opus).toBeCloseTo(2);
    expect(l.windows.five_hour!.other).toBeCloseTo(10);
    expect(l.pendingW).toEqual({});
  });

  it("weekly +1 at the end is split across many replies; 5h consumption does not remove them from weekly", () => {
    let l = applyReading(emptyLedger(), usage(0, 0), T0);
    let t = T0;
    for (let i = 0; i < 30; i++) {
      t += 60_000;
      l = addContribution(l, contrib(i % 2 ? "opus" : "sonnet", 10, t));
      if (i % 10 === 9) l = applyReading(l, usage((i + 1) / 10, 0), t + 4000); // 5h moves, weekly doesn't
    }
    expect(l.pendingW.five_hour).toBeUndefined();
    expect(l.pendingW.seven_day).toEqual({ opus: 150, sonnet: 150 });
    l = applyReading(l, usage(3, 1), t + 10_000);
    expect(l.windows.seven_day!.byModel.opus).toBeCloseTo(0.5);
    expect(l.windows.seven_day!.byModel.sonnet).toBeCloseTo(0.5);
    expect(l.windows.seven_day!.other).toBeCloseTo(0);
  });

  it("first sight clears pending", () => {
    let l = addContribution(emptyLedger(), contrib("opus", 5, T0 - 1000));
    l = applyReading(l, usage(20, 4), T0);
    expect(l.pendingW).toEqual({});
    expect(l.windows.five_hour!.other).toBe(20);
  });

  it("rollover distributes pending to the new cycle", () => {
    let l = applyReading(emptyLedger(), usage(50, 10), T0);
    l = addContribution(l, contrib("opus", 3, T0 + 1000));
    l = addContribution(l, contrib("sonnet", 1, T0 + 2000));
    l = applyReading(l, usage(4, 10, "2026-01-01T19:00:00Z"), T0 + 5 * 3600_000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(3);
    expect(l.windows.five_hour!.byModel.sonnet).toBeCloseTo(1);
    expect(l.pendingW.five_hour).toBeUndefined();
    expect(l.pendingW.seven_day).toEqual({ opus: 3, sonnet: 1 });
  });

  it("negative delta keeps pending", () => {
    let l = applyReading(emptyLedger(), usage(20, 5), T0);
    l = addContribution(l, contrib("opus", 1, T0 + 1000));
    l = applyReading(l, usage(15, 4), T0 + 5000);
    expect(l.pendingW.five_hour).toEqual({ opus: 1 });
    expect(sum(l, "five_hour")).toBeCloseTo(15);
  });

  it("migrates an old stored `pending` array", () => {
    const old = {
      windows: {}, lastReadingAt: 5, hubPrev: {},
      pending: [contrib("opus", 2, 1), contrib("opus", 3, 2), contrib("sonnet", 1, 3)],
    };
    const l = normalizeLedger(old);
    expect(l.pendingW.five_hour).toEqual({ opus: 5, sonnet: 1 });
    expect(l.pendingW.seven_day).toEqual({ opus: 5, sonnet: 1 });
    expect((l as unknown as Record<string, unknown>).pending).toBeUndefined();
    expect(normalizeLedger({ windows: {} }).pendingW).toEqual({});
    expect(normalizeLedger(undefined)).toEqual(emptyLedger());
  });

  it("small resetsAt jitter is the same cycle; a real change starts a new one", () => {
    let l = applyReading(emptyLedger(), usage(50, 10), T0);
    l = addContribution(l, contrib("opus", 1, T0 + 1000));
    l = applyReading(l, usage(52, 10, "2026-01-01T14:00:59Z"), T0 + 5000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(2);
    const l2 = applyReading(l, usage(3, 10, "2026-01-01T19:00:00Z"), T0 + 5 * 3600_000);
    expect(l2.windows.five_hour).toMatchObject({ cycle: "2026-01-01T19:00:00Z", byModel: {}, other: 3, lastUtil: 3 });
  });

  it("negative delta scales proportionally", () => {
    let l = applyReading(emptyLedger(), usage(20, 0), T0);
    l = addContribution(l, contrib("opus", 1, T0 + 1000));
    l = applyReading(l, usage(60, 0), T0 + 5000); // other 20, opus 40
    l = applyReading(l, usage(30, 0), T0 + 60_000);
    expect(l.windows.five_hour!.byModel.opus).toBeCloseTo(20);
    expect(l.windows.five_hour!.other).toBeCloseTo(10);
    expect(sum(l, "five_hour")).toBeCloseTo(30);
  });

  it("invariant over a random walk", () => {
    let l = emptyLedger();
    let u = 5;
    let t = T0;
    const models = ["opus", "sonnet", "haiku"];
    for (let i = 0; i < 200; i++) {
      t += 20_000;
      if (i % 3 === 0) l = addContribution(l, contrib(models[(i / 3) % 3], 1 + (i % 7), t - 5000));
      u = Math.max(0, Math.min(100, u + ((i * 7) % 5) - 1));
      l = applyReading(l, usage(u, u / 5), t);
      expect(sum(l, "five_hour")).toBeCloseTo(u, 6);
      expect(sum(l, "seven_day")).toBeCloseTo(u / 5, 6);
    }
  });

  it("stale (older) reading is ignored", () => {
    const l = applyReading(emptyLedger(), usage(10, 1), T0 + 1000);
    expect(applyReading(l, usage(5, 1), T0)).toBe(l);
  });
});

describe("recordHubSnapshot", () => {
  const dev = (tokens: Record<string, number>, source = "claude-code") => [{ deviceId: "d1", source, last5hByModel: tokens }];
  it("first sight is baseline only, then positive deltas become weighted contributions", () => {
    let r = recordHubSnapshot(emptyLedger(), dev({ "claude-opus-4": 1000 }), T0);
    expect(r.added).toBe(0);
    expect(r.ledger.pendingW).toEqual({});
    r = recordHubSnapshot(r.ledger, dev({ "claude-opus-4": 1400, "claude-haiku-4": 100 }), T0 + 30_000);
    expect(r.added).toBe(2);
    expect(r.ledger.pendingW.five_hour).toEqual({ "claude-opus-4": 2000, "claude-haiku-4": 30 });
    const r2 = recordHubSnapshot(r.ledger, dev({ "claude-opus-4": 1300 }), T0 + 60_000);
    expect(r2.added).toBe(0);
  });
  it("ignores chrome devices", () => {
    const r = recordHubSnapshot(emptyLedger(), dev({ a: 1 }, "chrome"), T0);
    expect(r.ledger.hubPrev).toEqual({});
  });
});

describe("row formatting", () => {
  it("formatPoints", () => {
    expect([formatPoints(52.4), formatPoints(0.2), formatPoints(0), formatPoints(0.5)]).toEqual(["52%", "<1%", "0%", "1%"]);
  });
  it("attributionRows sorts, merges dated ids, adds tokens and Other", () => {
    const v = attributionRows(
      { byModel: { "claude-sonnet-5-5": 19, "claude-opus-4-5": 52 }, other: 8 },
      { byModel: { "claude-opus-4-5": 7, "claude-sonnet-5-5": 3 }, other: 1 },
      { "claude-opus-4-5": 900, "claude-haiku-4-5-20251001": 500, "claude-haiku-4-5": 500 },
      true,
    );
    expect(v.rows.map((r) => [r.label, r.five, r.week, r.tokens])).toEqual([
      ["Opus 4.5:", "52%", "7%", "≈900"],
      ["Sonnet 5.5:", "19%", "3%", ""],
      ["Haiku 4.5:", "0%", "0%", "≈1k"],
    ]);
    expect([v.other.label, v.other.five, v.other.week]).toEqual(["Other:", "8%", "1%"]);
    expect(v.rows[0].title).toContain("attributed from changes");
  });
});
