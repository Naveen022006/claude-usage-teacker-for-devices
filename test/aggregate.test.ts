import { describe, it, expect } from "vitest";
import { computeAggregates, pruneEvents, MAX_EVENTS } from "../src/shared/aggregate";
import type { UsageEvent } from "../src/shared/types";

const H = 3600_000;
const now = new Date(2026, 5, 15, 14, 30, 0).getTime(); // local time
const midnight = new Date(2026, 5, 15, 0, 0, 0).getTime();

function ev(ts: number, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: String(Math.random()), ts, source: "chrome", deviceId: "d", model: "m1",
    promptChars: 0, outputChars: 0, thinkingChars: 0, promptTokens: 10, outputTokens: 20,
    estimated: true, status: "ok", kind: "new", ...over,
  };
}

describe("computeAggregates", () => {
  it("handles empty input", () => {
    const a = computeAggregates([], now);
    expect(a.today).toEqual({ messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} });
  });

  it("5h boundary: exactly 5h ago is inside, 1ms earlier is outside", () => {
    const a = computeAggregates([ev(now - 5 * H), ev(now - 5 * H - 1)], now);
    expect(a.last5h.messages).toBe(1);
    expect(a.last7d.messages).toBe(2);
  });

  it("7d boundary", () => {
    const a = computeAggregates([ev(now - 7 * 24 * H), ev(now - 7 * 24 * H - 1)], now);
    expect(a.last7d.messages).toBe(1);
  });

  it("today starts at local midnight", () => {
    const a = computeAggregates([ev(midnight), ev(midnight - 1)], now);
    expect(a.today.messages).toBe(1);
    expect(a.last7d.messages).toBe(2);
  });

  it("ignores future events", () => {
    expect(computeAggregates([ev(now + 1)], now).last7d.messages).toBe(0);
  });

  it("groups by model with tokens = prompt + output, and counts errors", () => {
    const a = computeAggregates(
      [ev(now - H), ev(now - H, { model: "m2", promptTokens: 1, outputTokens: 2 }), ev(now - H, { status: "error" })],
      now,
    );
    expect(a.last5h.messages).toBe(3);
    expect(a.last5h.promptTokens).toBe(21);
    expect(a.last5h.outputTokens).toBe(42);
    expect(a.last5h.byModel.m1).toEqual({ messages: 2, tokens: 60 });
    expect(a.last5h.byModel.m2).toEqual({ messages: 1, tokens: 3 });
  });
});

describe("pruneEvents", () => {
  it("drops events older than 30 days", () => {
    const d30 = 30 * 24 * H;
    const out = pruneEvents([ev(now - d30 - 1), ev(now - d30), ev(now)], now);
    expect(out.map((e) => e.ts)).toEqual([now - d30, now]);
  });

  it("caps count, keeping newest", () => {
    const events = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ev(now - 1000 + i));
    const out = pruneEvents(events, now);
    expect(out).toHaveLength(MAX_EVENTS);
    expect(Math.min(...out.map((e) => e.ts))).toBe(now - 1000 + 5);
  });
});
