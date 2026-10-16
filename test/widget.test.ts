import { describe, expect, it } from "vitest";
import type { HubDevice } from "../src/shared/messages";
import type { Aggregates, WindowAggregate } from "../src/shared/types";
import { parseHubState } from "../src/sync/hub";
import {
  formatAgo,
  formatCountdown,
  formatPct,
  formatTokens,
  humanizeWindow,
  mergeDevices,
  modelRows,
  pillLabel,
  shortModel,
  sortWindows,
  tone,
  totalsLine,
} from "../src/widget/helpers";
import { validateWidgetRequest } from "../src/shared/validate";

const win = (messages: number, byModel: WindowAggregate["byModel"] = {}): WindowAggregate => ({
  messages,
  promptTokens: 1200,
  outputTokens: 300,
  byModel,
});
const aggs = (w: WindowAggregate): Aggregates => ({ today: w, last5h: w, last7d: w });

describe("widget helpers", () => {
  it("tone thresholds", () => {
    expect([tone(0), tone(59.9), tone(60), tone(84.9), tone(85), tone(100)]).toEqual(["ok", "ok", "warn", "warn", "bad", "bad"]);
  });
  it("humanizes window names", () => {
    expect(humanizeWindow("five_hour")).toBe("Current session (5h)");
    expect(humanizeWindow("seven_day")).toBe("Weekly · all models");
    expect(humanizeWindow("seven_day_opus")).toBe("Weekly · Opus");
    expect(humanizeWindow("seven_day_sonnet")).toBe("Weekly · Sonnet");
    expect(humanizeWindow("seven_day_oauth_apps")).toBe("Seven Day Oauth Apps");
  });
  it("sorts windows five_hour first", () => {
    const names = sortWindows([{ name: "zzz", utilization: 1 }, { name: "seven_day_opus", utilization: 1 }, { name: "five_hour", utilization: 1 }, { name: "seven_day", utilization: 1 }]).map((w) => w.name);
    expect(names).toEqual(["five_hour", "seven_day", "seven_day_opus", "zzz"]);
  });
  it("formats countdowns", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(formatCountdown(at(2 * 3600_000 + 14 * 60_000), now)).toBe("2h 14m");
    expect(formatCountdown(at(14 * 60_000), now)).toBe("14m");
    expect(formatCountdown(at(30_000), now)).toBe("1m");
    expect(formatCountdown(at(-5000), now)).toBe("now");
    expect(formatCountdown(at(3 * 86400_000 + 4 * 3600_000), now)).toBe("3d 4h");
    expect(formatCountdown(undefined, now)).toBe("");
    expect(formatCountdown("garbage", now)).toBe("");
  });
  it("formats ago, tokens, pct, model", () => {
    expect(formatAgo(1000, 13_000)).toBe("12s ago");
    expect(formatAgo(0, 5)).toBe("never");
    expect(formatAgo(1, 2 * 3600_000 + 1)).toBe("2h ago");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
    expect(formatPct(41.6)).toBe("42%");
    expect(formatPct(250)).toBe("100%");
    expect(shortModel("claude-sonnet-5-5")).toBe("sonnet-5-5");
  });
  it("pill label", () => {
    expect(pillLabel(undefined)).toBe("Usage");
    expect(pillLabel([{ name: "seven_day", utilization: 3 }])).toBe("Usage");
    expect(pillLabel([{ name: "five_hour", utilization: 42.2 }])).toBe("5h 42%");
  });
  it("totals line marks estimates only", () => {
    expect(totalsLine(win(3), true)).toBe("3 msgs · ≈1.2k in / ≈300 out");
    expect(totalsLine(win(1), false)).toBe("1 msg · 1.2k in / 300 out");
  });
  it("model rows sorted by messages with relative share", () => {
    const rows = modelRows(win(5, { "claude-haiku-4": { messages: 1, tokens: 100 }, "claude-sonnet-5-5": { messages: 4, tokens: 400 } }));
    expect(rows.map((r) => r.model)).toEqual(["sonnet-5-5", "haiku-4"]);
    expect(rows[0].share).toBe(100);
    expect(rows[1].share).toBe(25);
    expect(modelRows(win(0))).toEqual([]);
  });
});

describe("mergeDevices", () => {
  const hubDev = (id: string, over: Partial<HubDevice> = {}): HubDevice => ({
    deviceId: id, deviceName: id, source: "claude-code", estimated: false, receivedAt: 1000, fresh: true, windows: aggs(win(1)), ...over,
  });
  it("puts this browser first and excludes own deviceId from hub list", () => {
    const cards = mergeDevices({ deviceId: "me", windows: aggs(win(3)) }, [hubDev("me", { source: "chrome" }), hubDev("cc"), hubDev("desk", { source: "desktop", receivedAt: 5 , fresh: false })]);
    expect(cards.map((c) => c.title)).toEqual(["This browser", "cc", "desk"]);
    expect(cards[0].estimated).toBe(true);
    expect(cards[1].badge).toBe("Claude Code");
    expect(cards[2].badge).toBe("Desktop");
    expect(cards[2].fresh).toBe(false);
  });
  it("works without hub", () => {
    expect(mergeDevices({ deviceId: "me", windows: aggs(win(0)) }, [])).toHaveLength(1);
  });
});

describe("parseHubState / validateWidgetRequest", () => {
  it("parses a hub /api/state body defensively", () => {
    const body = {
      ok: true, now: 1, totals: {}, account: null, daily: [],
      devices: [
        { deviceId: "a", deviceName: "A", source: "desktop", estimated: false, receivedAt: 10, fresh: true, sentAt: 9,
          windows: { today: { messages: 2, promptTokens: 1, outputTokens: 2, byModel: { m: { messages: 2, tokens: 3 } } } } },
        { nope: true },
      ],
    };
    const d = parseHubState(body)!;
    expect(d).toHaveLength(1);
    expect(d[0].source).toBe("desktop");
    expect(d[0].windows.today.byModel.m).toEqual({ messages: 2, tokens: 3 });
    expect(d[0].windows.last7d.messages).toBe(0);
    expect(parseHubState({ ok: false })).toBeNull();
    expect(parseHubState(null)).toBeNull();
  });
  it("accepts only the two widget request types", () => {
    expect(validateWidgetRequest({ ns: "claude-usage", type: "get-widget-state" })?.type).toBe("get-widget-state");
    expect(validateWidgetRequest({ ns: "claude-usage", type: "open-options" })?.type).toBe("open-options");
    expect(validateWidgetRequest({ ns: "claude-usage", type: "clear-data" })).toBeNull();
    expect(validateWidgetRequest({ type: "get-widget-state" })).toBeNull();
  });
});
