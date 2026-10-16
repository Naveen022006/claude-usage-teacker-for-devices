import { describe, expect, it } from "vitest";
import {
  dayInTz, mergedView, shouldApplyAccount, shouldApplyDevice, validateReport, type StoredDevice,
} from "@/lib/contract";
import { checkToken, bearerOf } from "@/lib/auth";

const win = (m = 1) => ({ messages: m, promptTokens: 10, outputTokens: 20, byModel: { "claude-opus-5-5": { messages: m, tokens: 30 } } });
const good = () => ({
  v: 1, deviceId: "d1", deviceName: "Laptop", source: "chrome", sentAt: 1000, estimated: true,
  windows: { today: win(), last5h: win(), last7d: win() },
  account: { fetchedAt: 5, windows: [{ name: "five_hour", utilization: 42, resetsAt: "2026-01-01T00:00:00Z" }] },
});

describe("validateReport", () => {
  it("accepts a good report", () => expect(validateReport(good())?.deviceId).toBe("d1"));
  it("accepts null account", () => expect(validateReport({ ...good(), account: null })).not.toBeNull());
  it("rejects wrong version / source / missing id", () => {
    expect(validateReport({ ...good(), v: 2 })).toBeNull();
    expect(validateReport({ ...good(), source: "phone" })).toBeNull();
    expect(validateReport({ ...good(), deviceId: "" })).toBeNull();
    expect(validateReport(null)).toBeNull();
    expect(validateReport([])).toBeNull();
  });
  it("rejects negative / non-finite numbers", () => {
    const a = good(); a.windows.today.messages = -1;
    expect(validateReport(a)).toBeNull();
    const b = good(); b.windows.today.byModel["claude-opus-5-5"].tokens = Infinity;
    expect(validateReport(b)).toBeNull();
    const c = good(); (c.windows.last5h as any).promptTokens = "5";
    expect(validateReport(c)).toBeNull();
  });
  it("enforces string caps and missing windows", () => {
    expect(validateReport({ ...good(), deviceName: "x".repeat(101) })).toBeNull();
    expect(validateReport({ ...good(), deviceId: "x".repeat(129) })).toBeNull();
    const d: any = good(); delete d.windows.last7d;
    expect(validateReport(d)).toBeNull();
    const e = good(); e.account!.windows[0].name = "n".repeat(33);
    expect(validateReport(e)).toBeNull();
  });
});

describe("merge rules", () => {
  it("ignores older device reports, applies newer or equal", () => {
    expect(shouldApplyDevice(null, 1)).toBe(true);
    expect(shouldApplyDevice(100, 99)).toBe(false);
    expect(shouldApplyDevice(100, 100)).toBe(true);
    expect(shouldApplyDevice(100, 101)).toBe(true);
  });
  it("applies account only if strictly newer", () => {
    expect(shouldApplyAccount(null, 1)).toBe(true);
    expect(shouldApplyAccount(5, 5)).toBe(false);
    expect(shouldApplyAccount(5, 6)).toBe(true);
  });
  it("totals sum fresh devices only", () => {
    const now = 10_000_000;
    const mk = (id: string, receivedAt: number): StoredDevice => ({
      deviceId: id, deviceName: id, source: "chrome", estimated: false, sentAt: 1, receivedAt,
      windows: { today: win(2), last5h: win(), last7d: win() },
    });
    const v = mergedView([mk("a", now - 1000), mk("b", now - 11 * 60 * 1000)], now);
    expect(v.devices.map((d) => d.fresh)).toEqual([true, false]);
    expect(v.totals.today.messages).toBe(2);
    expect(v.totals.today.byModel["claude-opus-5-5"].tokens).toBe(30);
  });
  it("dayInTz respects timezone and falls back to UTC", () => {
    const t = Date.parse("2026-03-01T23:30:00Z");
    expect(dayInTz(t, "UTC")).toBe("2026-03-01");
    expect(dayInTz(t, "Asia/Kolkata")).toBe("2026-03-02");
    expect(dayInTz(t, "Not/AZone")).toBe("2026-03-01");
  });
});

describe("auth helpers", () => {
  it("token + bearer helpers", () => {
    expect(checkToken("abc", "abc")).toBe(true);
    expect(checkToken("abd", "abc")).toBe(false);
    expect(checkToken("", "abc")).toBe(false);
    expect(bearerOf("Bearer xyz")).toBe("xyz");
    expect(bearerOf("Basic xyz")).toBeNull();
  });
});
