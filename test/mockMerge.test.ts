import { describe, expect, it } from "vitest";
import { FRESH_MS, applyReport, mergedView, newState, validateReport } from "../tools/mock-merge.mjs";

type M = Record<string, { messages: number; tokens: number }>;
const win = (messages: number, byModel: M = {}) => ({ messages, promptTokens: messages * 10, outputTokens: messages * 5, byModel });
const rep = (deviceId: string, messages = 1, extra: Record<string, unknown> = {}) => ({
  v: 1, deviceId, deviceName: deviceId, source: "claude-code", sentAt: 0, estimated: false, account: null,
  windows: { today: win(messages), last5h: win(messages), last7d: win(messages) }, ...extra,
});

describe("validateReport", () => {
  it("requires v=1 and deviceId", () => {
    expect(validateReport(rep("a"))).not.toBeNull();
    expect(validateReport({ ...rep("a"), v: 2 })).toBeNull();
    expect(validateReport({ ...rep("a"), deviceId: "" })).toBeNull();
    expect(validateReport({ v: 1 })).toBeNull();
    expect(validateReport(null)).toBeNull();
    expect(validateReport([])).toBeNull();
  });
});

describe("merge", () => {
  it("keeps the latest report per device", () => {
    const s = newState();
    applyReport(s, rep("a", 1), 1000);
    applyReport(s, rep("a", 7), 2000);
    expect(s.devices.size).toBe(1);
    expect(mergedView(s, 2000).totals.today.messages).toBe(7);
  });
  it("evicts the oldest receivedAt beyond 8 devices", () => {
    const s = newState();
    for (let i = 0; i < 8; i++) applyReport(s, rep("d" + i), 1000 + i);
    applyReport(s, rep("d0"), 5000); // refresh d0 -> d1 is now oldest
    applyReport(s, rep("new"), 6000);
    expect(s.devices.size).toBe(8);
    expect(s.devices.has("d1")).toBe(false);
    expect(s.devices.has("d0")).toBe(true);
    expect(s.devices.has("new")).toBe(true);
  });
  it("folds models beyond the top 6 into other", () => {
    const s = newState();
    const byModel: M = {};
    for (let i = 1; i <= 8; i++) byModel["m" + i] = { messages: 1, tokens: i * 100 };
    applyReport(s, rep("a", 1, { windows: { today: win(8, byModel), last5h: win(0), last7d: win(0) } }), 1);
    const bm = s.devices.get("a").windows.today.byModel;
    expect(Object.keys(bm).sort()).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "other"]);
    expect(bm.other).toEqual({ messages: 2, tokens: 300 });
  });
  it("truncates strings", () => {
    const s = newState();
    const byModel: M = { ["m".repeat(60)]: { messages: 1, tokens: 1 } };
    applyReport(s, rep("x".repeat(100), 1, { deviceName: "n".repeat(50), windows: { today: win(1, byModel), last5h: win(0), last7d: win(0) } }), 1);
    const d = [...s.devices.values()][0];
    expect(d.deviceId).toHaveLength(64);
    expect(d.deviceName).toHaveLength(32);
    expect(Object.keys(d.windows.today.byModel)[0]).toHaveLength(40);
  });
  it("sums only fresh devices but still lists stale ones", () => {
    const s = newState();
    applyReport(s, rep("old", 10), 0);
    applyReport(s, rep("new", 3), FRESH_MS + 1000);
    const v = mergedView(s, FRESH_MS + 1000);
    expect(v.devices).toHaveLength(2);
    expect(v.devices.find((d: any) => d.deviceId === "old").fresh).toBe(false);
    expect(v.totals.today.messages).toBe(3);
    expect(mergedView(s, FRESH_MS - 1).devices.find((d: any) => d.deviceId === "old").fresh).toBe(true);
  });
  it("merges byModel across fresh devices", () => {
    const s = newState();
    const w = (n: number) => ({ today: win(n, { opus: { messages: n, tokens: n * 10 } }), last5h: win(0), last7d: win(0) });
    applyReport(s, rep("a", 1, { windows: w(2) }), 1);
    applyReport(s, rep("b", 1, { windows: w(3) }), 1);
    expect(mergedView(s, 1).totals.today.byModel.opus).toEqual({ messages: 5, tokens: 50 });
  });
  it("newest account fetchedAt wins regardless of device", () => {
    const s = newState();
    const acc = (fetchedAt: number, u: number) => ({ fetchedAt, windows: [{ name: "five_hour", utilization: u }] });
    applyReport(s, rep("a", 1, { account: acc(200, 50) }), 1);
    applyReport(s, rep("b", 1, { account: acc(100, 10) }), 2);
    expect(s.account.windows[0].utilization).toBe(50);
    applyReport(s, rep("b", 1, { account: acc(300, 70) }), 3);
    expect(s.account.windows[0].utilization).toBe(70);
    applyReport(s, rep("c", 1, { account: null }), 4);
    expect(s.account.fetchedAt).toBe(300);
  });
});
