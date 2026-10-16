import { describe, expect, it } from "vitest";
import type { HubDevice } from "../src/shared/messages";
import type { Aggregates, WindowAggregate } from "../src/shared/types";
import { sanitizeDeviceIds } from "../src/shared/validate";
import { CODE_SOURCES, combineDevices, formatCountdown, modelShares, msUntil, pickWindow, themeFromColor } from "../src/widget/helpers";

const win = (messages: number): WindowAggregate => ({ messages, promptTokens: 0, outputTokens: 0, byModel: {} });

describe("sidebar helpers", () => {
  it("formatCountdown: h:mm:ss under 24h, d h m beyond, now when elapsed", () => {
    expect(formatCountdown(2 * 3600_000 + 14 * 60_000 + 5_000)).toBe("2:14:05");
    expect(formatCountdown(59_000)).toBe("0:00:59");
    expect(formatCountdown(23 * 3600_000 + 59 * 60_000 + 59_000)).toBe("23:59:59");
    expect(formatCountdown(3 * 86400_000 + 4 * 3600_000 + 12 * 60_000 + 30_000)).toBe("3d 4h 12m");
    expect(formatCountdown(86400_000)).toBe("1d 0h 0m");
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5)).toBe("now");
    expect(formatCountdown(NaN)).toBe("now");
  });
  it("msUntil", () => {
    expect(msUntil("1970-01-01T00:00:10Z", 0)).toBe(10_000);
    expect(msUntil(undefined, 0)).toBeNull();
    expect(msUntil("bad", 0)).toBeNull();
  });
  it("modelShares sums to exactly 100, sorted desc, largest remainder", () => {
    const r = modelShares({ "claude-a": { messages: 1, tokens: 1 }, "claude-b": { messages: 1, tokens: 1 }, "claude-c": { messages: 1, tokens: 1 } });
    expect(r.reduce((a, x) => a + x.pct, 0)).toBe(100);
    expect(r.map((x) => x.pct).sort()).toEqual([33, 33, 34]);
    expect(
      modelShares({ "claude-sonnet-5-5": { messages: 31, tokens: 12400 }, "claude-haiku-4-5": { messages: 5, tokens: 7600 } }),
    ).toEqual([
      { model: "sonnet-5-5", pct: 62, tokens: 12400, messages: 31 },
      { model: "haiku-4-5", pct: 38, tokens: 7600, messages: 5 },
    ]);
    expect(modelShares({})).toEqual([]);
    expect(modelShares({ m: { messages: 0, tokens: 0 } })).toEqual([]);
    expect(modelShares({ a: { messages: 3, tokens: 0 }, b: { messages: 1, tokens: 0 } }).map((x) => x.pct)).toEqual([75, 25]);
    const many: WindowAggregate["byModel"] = {};
    for (let i = 0; i < 11; i++) many["m" + i] = { messages: 1, tokens: 7 + i };
    expect(modelShares(many).reduce((a, x) => a + x.pct, 0)).toBe(100);
  });
  it("combineDevices: explicit ids, auto, none", () => {
    const dev = (id: string, source: HubDevice["source"], tokens: number, estimated = false): HubDevice => {
      const w: WindowAggregate = { messages: 1, promptTokens: tokens, outputTokens: 0, byModel: { "claude-x": { messages: 1, tokens } } };
      return { deviceId: id, deviceName: id, source, estimated, receivedAt: 1, fresh: true, windows: { today: w, last5h: w, last7d: w } };
    };
    const list = [dev("cc1", "claude-code", 10), dev("dk", "desktop", 5), dev("br", "chrome", 100, true)];
    const auto = combineDevices(list, [], true);
    expect(auto.devices.map((d) => d.deviceId)).toEqual(["cc1", "dk"]);
    expect(auto.windows.last5h.byModel["claude-x"]).toEqual({ messages: 2, tokens: 15 });
    expect(auto.windows.today.promptTokens).toBe(15);
    expect(auto.exact).toBe(true);
    expect(combineDevices(list, ["dk", "nope"], true).devices.map((d) => d.deviceId)).toEqual(["dk"]);
    expect(combineDevices(list, [], false).devices).toEqual([]);
    expect(combineDevices(list, ["br"], true).exact).toBe(false);
    expect(CODE_SOURCES).toEqual(["claude-code", "desktop"]);
  });
  it("pickWindow", () => {
    const a: Aggregates = { today: win(1), last5h: win(2), last7d: win(3) };
    expect([pickWindow(a, "session").messages, pickWindow(a, "today").messages, pickWindow(a, "week").messages]).toEqual([2, 1, 3]);
  });
  it("themeFromColor: light text means dark theme", () => {
    expect(themeFromColor("rgb(232, 230, 227)")).toBe("dark");
    expect(themeFromColor("rgba(31, 30, 29, 0.9)")).toBe("light");
    expect(themeFromColor("garbage")).toBeNull();
  });
  it("sanitizeDeviceIds", () => {
    expect(sanitizeDeviceIds("x")).toBeNull();
    expect(sanitizeDeviceIds(["a", "a", "", 5, "b".repeat(129), "c"])).toEqual(["a", "c"]);
    expect(sanitizeDeviceIds(Array.from({ length: 30 }, (_, i) => "d" + i))).toHaveLength(20);
  });
});
