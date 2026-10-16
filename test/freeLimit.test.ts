import { describe, expect, it } from "vitest";
import { freeLimitText, freeLimitView, toIso } from "../src/widget/helpers";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const SEC = Math.floor(NOW / 1000);
const hint = (fields: Record<string, string | number | boolean>, ts = NOW - 1000) => ({ ts, fields });

describe("toIso", () => {
  it("handles epoch seconds, ms, numeric strings and ISO", () => {
    const iso = "2026-10-16T15:00:00.000Z";
    expect(toIso(SEC + 10800)).toBe(iso);
    expect(toIso((SEC + 10800) * 1000)).toBe(iso);
    expect(toIso(String(SEC + 10800))).toBe(iso);
    expect(toIso(iso)).toBe(iso);
  });
  it("rejects junk", () => {
    for (const v of [null, undefined, "", "nope", NaN, 0, -5, {}]) expect(toIso(v)).toBeNull();
  });
});

describe("freeLimitView", () => {
  it("returns an empty view for null / stale (>6h) hints", () => {
    const empty = { status: null, remaining: null, resetsAt: null, windows: [] };
    expect(freeLimitView(null, NOW)).toEqual(empty);
    expect(freeLimitView(hint({ "message_limit.type": "within_limit" }, NOW - 6 * 3600_000 - 1), NOW)).toEqual(empty);
  });
  it("maps statuses", () => {
    const st = (t: string) => freeLimitView(hint({ "message_limit.type": t }), NOW).status;
    expect(st("within_limit")).toBe("within");
    expect(st("approaching_limit")).toBe("approaching");
    expect(st("exceeded_limit")).toBe("exceeded");
    expect(st("something_else")).toBeNull();
  });
  it("reads remaining and resetsAt (epoch s / ms / ISO)", () => {
    const iso = new Date((SEC + 3600) * 1000).toISOString();
    for (const r of [SEC + 3600, (SEC + 3600) * 1000, iso]) {
      const v = freeLimitView(hint({ "message_limit.type": "approaching_limit", "message_limit.remaining": 3, "message_limit.resetsAt": r }), NOW);
      expect(v).toMatchObject({ status: "approaching", remaining: 3, resetsAt: iso });
    }
  });
  it("tolerates nulls / missing fields", () => {
    expect(freeLimitView(hint({}), NOW)).toEqual({ status: null, remaining: null, resetsAt: null, windows: [] });
    expect(freeLimitView(hint({ "message_limit.remaining": -1 }), NOW).remaining).toBeNull();
  });
  it("drops status once resetsAt has passed", () => {
    const v = freeLimitView(hint({ "message_limit.type": "exceeded_limit", "message_limit.resetsAt": SEC - 5 }), NOW);
    expect(v.status).toBeNull();
    expect(v.resetsAt).toBeNull();
  });
  it("parses windows with utilization 0-1 and 0-100, sorted 5h then 7d", () => {
    const v = freeLimitView(
      hint({
        "message_limit.windows.7d.utilization": 12.5,
        "message_limit.windows.7d.resets_at": SEC + 86400,
        "message_limit.windows.5h.utilization": 0.42,
        "message_limit.windows.5h.resets_at": SEC + 600,
        "message_limit.windows.5h.status": "approaching_limit",
      }),
      NOW,
    );
    expect(v.windows.map((w) => w.name)).toEqual(["5h", "7d"]);
    expect(v.windows[0].pct).toBeCloseTo(42);
    expect(v.windows[1].pct).toBe(12.5);
    expect(v.windows[0].resetsAt).toBe(new Date((SEC + 600) * 1000).toISOString());
    expect(v.status).toBe("approaching"); // derived from the window
  });
  it("normalises window names, drops elapsed windows, null pct when no utilization", () => {
    const v = freeLimitView(
      hint({
        "windows.five_hour.utilization": 50,
        "windows.seven_day.utilization": 10,
        "windows.seven_day.resetsAt": SEC - 1,
        "windows.opus.status": "within_limit",
      }),
      NOW,
    );
    expect(v.windows).toEqual([
      { name: "5h", pct: 50, resetsAt: null },
      { name: "opus", pct: null, resetsAt: null },
    ]);
  });
  it("clamps utilization", () => {
    expect(freeLimitView(hint({ "windows.5h.utilization": 250 }), NOW).windows[0].pct).toBe(100);
  });
});

describe("freeLimitText", () => {
  it("renders row text", () => {
    const base = { remaining: null, resetsAt: null, windows: [] };
    expect(freeLimitText({ ...base, status: "within" })).toBe("Within limit");
    expect(freeLimitText({ ...base, status: "exceeded" })).toBe("Limit reached");
    expect(freeLimitText({ ...base, status: "approaching", remaining: 3 })).toBe("3 msgs left");
    expect(freeLimitText({ ...base, status: "approaching", remaining: 1 })).toBe("1 msg left");
    expect(freeLimitText({ ...base, status: "approaching" })).toBe("Approaching limit");
  });
});
