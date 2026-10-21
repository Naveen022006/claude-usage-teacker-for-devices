import { describe, expect, it } from "vitest";
import {
  addDeviceContribution, addSessionActivity, applyReadingWithSessions, applyDeviceReading, rememberNames, deviceView, emptyDeviceLedger, normalizeDeviceLedger, recordHubDevices, baselineWeights, DEVICE_LEDGER_VERSION,
  type DeviceLedger,
} from "../src/shared/deviceAttribution";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const R5 = "2026-01-01T14:00:00Z";
const R7 = "2026-01-05T10:00:00Z";
const usage = (u5: number, u7: number, r5 = R5, r7 = R7) => ({
  windows: [
    { name: "five_hour", utilization: u5, resetsAt: r5 },
    { name: "seven_day", utilization: u7, resetsAt: r7 },
  ],
});
const start = (u5 = 0, u7 = 0) => applyDeviceReading(emptyDeviceLedger(), usage(u5, u7), T0);
const rowOf = (dl: DeviceLedger, key: string, w: "five_hour" | "seven_day" = "five_hour") =>
  deviceView(dl, {})[w]!.rows.find((r) => r.key === key);
const conserved = (dl: DeviceLedger, w: "five_hour" | "seven_day", util: number) => {
  const v = deviceView(dl, {})[w]!;
  const all = Object.values(dl.ledger.windows[w]!.byModel).reduce((a, b) => a + b, 0);
  expect(Math.abs(all + v.unattributedPts - util)).toBeLessThan(1e-6);
};

describe("applyDeviceReading", () => {
  it("a single local device gets the whole rise, high confidence", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 10, T0 + 1000);
    dl = applyDeviceReading(dl, usage(6, 2), T0 + 5000);
    const r = rowOf(dl, "local")!;
    expect(r.pts).toBeCloseTo(6);
    expect(r.share).toBeCloseTo(1);
    expect(r.confidence).toBe("high");
    expect(rowOf(dl, "local", "seven_day")!.pts).toBeCloseTo(2);
  });

  it("local + hub device in the same interval split by weight, both low", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 30, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 10, T0 + 2000);
    dl = applyDeviceReading(dl, usage(8, 0), T0 + 5000);
    const a = rowOf(dl, "local")!;
    const b = rowOf(dl, "hub:d1")!;
    expect(a.pts).toBeCloseTo(6);
    expect(b.pts).toBeCloseTo(2);
    expect(a.confidence).toBe("low");
    expect(b.confidence).toBe("low");
    // a later single-device interval dilutes the low share below half
    dl = addDeviceContribution(dl, "local", 5, T0 + 10_000);
    dl = applyDeviceReading(dl, usage(24, 0), T0 + 20_000);
    expect(rowOf(dl, "local")!.confidence).toBe("high");
    expect(rowOf(dl, "hub:d1")!.confidence).toBe("low");
  });

  it("no evidence goes to unattributed", () => {
    let dl = start(10, 1);
    dl = applyDeviceReading(dl, usage(14, 1), T0 + 60_000);
    const v = deviceView(dl, {}).five_hour!;
    expect(v.rows.filter((r) => r.pts > 0)).toEqual([]); // only the always-present empty local row
    expect(v.unattributedPts).toBeCloseTo(14);
    expect(v.totalPts).toBeCloseTo(14);
  });

  it("a window reset starts fresh", () => {
    let dl = start(5, 10);
    dl = addDeviceContribution(dl, "local", 1, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 1, T0 + 2000);
    dl = applyDeviceReading(dl, usage(10, 10), T0 + 5000);
    expect(dl.splitPts.five_hour!.local).toBeGreaterThan(0);
    dl = applyDeviceReading(dl, usage(3, 10, "2026-01-01T19:00:00Z"), T0 + 5 * 3600_000);
    const v = deviceView(dl, {}).five_hour!;
    expect(v.rows.filter((r) => r.pts > 0)).toEqual([]); // only the always-present empty local row
    expect(v.unattributedPts).toBeCloseTo(3);
    expect(dl.splitPts.five_hour).toEqual({});
    expect(dl.cycle.five_hour).toBe("2026-01-01T19:00:00Z");
  });

  it("rollover with two pending devices counts the first points as split", () => {
    let dl = start(50, 10);
    dl = addDeviceContribution(dl, "local", 3, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 1, T0 + 2000);
    dl = applyDeviceReading(dl, usage(4, 10, "2026-01-01T19:00:00Z"), T0 + 5 * 3600_000);
    expect(rowOf(dl, "local")!.pts).toBeCloseTo(3);
    expect(rowOf(dl, "local")!.confidence).toBe("low");
  });

  it("a utilisation drop scales rows and splitPts together", () => {
    let dl = start(0, 0);
    dl = addDeviceContribution(dl, "local", 1, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 1, T0 + 2000);
    dl = applyDeviceReading(dl, usage(40, 0), T0 + 5000); // 20 / 20, all split
    dl = applyDeviceReading(dl, usage(20, 0), T0 + 60_000);
    expect(rowOf(dl, "local")!.pts).toBeCloseTo(10);
    expect(dl.splitPts.five_hour!.local).toBeCloseTo(10);
    for (const [k, v] of Object.entries(dl.splitPts.five_hour!)) expect(v).toBeLessThanOrEqual(dl.ledger.windows.five_hour!.byModel[k] + 1e-9);
    conserved(dl, "five_hour", 20);
  });

  it("stale reading leaves the ledger untouched", () => {
    const dl = start(5, 1);
    expect(applyDeviceReading(dl, usage(9, 1), T0 - 1000)).toBe(dl);
  });
});

describe("recordHubDevices", () => {
  const dev = (tokens: Record<string, number>, source = "claude-code", deviceId = "d1") => [{ deviceId, source, last5hByModel: tokens }];
  it("first sight is baseline only, then the delta counts for hub:<id>", () => {
    let dl = recordHubDevices(emptyDeviceLedger(), dev({ "claude-opus-4": 1000 }), T0, null);
    expect(dl.ledger.pendingW).toEqual({});
    expect(dl.hubPrev.d1).toBe(5000);
    dl = recordHubDevices(dl, dev({ "claude-opus-4": 1400, "claude-haiku-4": 100 }), T0 + 30_000, null);
    expect(dl.ledger.pendingW.five_hour).toEqual({ "hub:d1": 2030 });
    expect(dl.ledger.hubPrev).toEqual({}); // own copy, ledger.hubPrev unused
  });
  it("a negative delta resets the baseline; other sources are ignored", () => {
    let dl = recordHubDevices(emptyDeviceLedger(), dev({ "claude-sonnet-5": 1000 }), T0, null);
    dl = recordHubDevices(dl, dev({ "claude-sonnet-5": 200 }), T0 + 1000, null);
    expect(dl.ledger.pendingW).toEqual({});
    expect(dl.hubPrev.d1).toBe(200);
    dl = recordHubDevices(dl, dev({ "claude-sonnet-5": 300 }), T0 + 2000, null);
    expect(dl.ledger.pendingW.five_hour).toEqual({ "hub:d1": 100 });
    const c = recordHubDevices(emptyDeviceLedger(), dev({ a: 1 }, "unknown-source"), T0, null);
    expect(c.hubPrev).toEqual({});
  });
  it("other Chrome installs count; the device matching selfDeviceId is skipped", () => {
    const both = (a: number, b: number) => [
      { deviceId: "me", source: "chrome", last5hByModel: { "claude-sonnet-5": a } },
      { deviceId: "other", source: "chrome", last5hByModel: { "claude-sonnet-5": b } },
    ];
    let dl = recordHubDevices(emptyDeviceLedger(), both(1000, 1000), T0, "me");
    expect(Object.keys(dl.hubPrev)).toEqual(["other"]);
    dl = recordHubDevices(dl, both(2000, 1500), T0 + 1000, "me");
    expect(Object.keys(dl.ledger.pendingW.five_hour ?? {})).toEqual(["hub:other"]);
    expect(dl.hubPrev.me).toBeUndefined();
  });
  it("caps at 50 hub devices", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ deviceId: "x" + i, source: "desktop", last5hByModel: { m: 1 } }));
    expect(Object.keys(recordHubDevices(emptyDeviceLedger(), many, T0, null).hubPrev).length).toBe(50);
  });
});

describe("deviceView", () => {
  it("sorts by points, drops tiny rows, applies labels", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 100, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 300, T0 + 2000);
    dl = addDeviceContribution(dl, "hub:d2", 0.01, T0 + 2500);
    dl = applyDeviceReading(dl, usage(10, 0), T0 + 5000);
    const v = deviceView(dl, { local: "This browser" }).five_hour!;
    expect(v.rows.map((r) => r.key)).toEqual(["hub:d1", "local"]);
    expect(v.rows[1].label).toBe("This browser");
    expect(v.rows[0].label).toBe("Other device");
    expect(v.cycle).toBe(R5);
  });
  it("share is 0 when the total is 0", () => {
    expect(deviceView(start(0, 0), {}).five_hour).toMatchObject({ totalPts: 0, rows: [expect.objectContaining({ key: "local", pts: 0, share: 0 })] });
  });
});

describe("conservation", () => {
  it("sum of rows + unattributed equals utilisation over a random-ish sequence", () => {
    let dl = emptyDeviceLedger();
    let u = 5;
    let t = T0;
    const keys = ["local", "hub:a", "hub:b"];
    for (let i = 0; i < 200; i++) {
      t += 20_000;
      if (i % 3 === 0) dl = addDeviceContribution(dl, keys[(i / 3) % 3], 1 + (i % 7), t - 5000);
      if (i % 5 === 0) dl = addDeviceContribution(dl, keys[(i + 1) % 3], 2, t - 4000);
      u = Math.max(0, Math.min(100, u + ((i * 7) % 5) - 1));
      dl = applyDeviceReading(dl, usage(u, u / 5), t);
      conserved(dl, "five_hour", u);
      conserved(dl, "seven_day", u / 5);
      for (const w of ["five_hour", "seven_day"] as const) {
        for (const [k, v] of Object.entries(dl.splitPts[w] ?? {})) expect(v).toBeLessThanOrEqual((dl.ledger.windows[w]!.byModel[k] ?? 0) + 1e-9);
      }
    }
  });
});

describe("normalizeDeviceLedger", () => {
  it("garbage gives an empty ledger", () => {
    for (const g of [undefined, null, 5, "x", [], { ledger: 7, splitPts: "no", cycle: 3, hubPrev: [] }]) {
      expect(normalizeDeviceLedger(g)).toEqual(emptyDeviceLedger());
    }
  });
  it("round-trips a real ledger through JSON", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 3, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 1, T0 + 2000);
    dl = applyDeviceReading(dl, usage(4, 0), T0 + 5000);
    expect(normalizeDeviceLedger(JSON.parse(JSON.stringify(dl)))).toEqual(dl);
  });
});

describe("device names", () => {
  const withHub = (name?: string) => {
    let dl = start();
    dl = recordHubDevices(dl, [{ deviceId: "d1", source: "claude-code", last5hByModel: { "claude-sonnet-4": 100 }, deviceName: name }], T0, null);
    dl = addDeviceContribution(dl, "hub:d1", 10, T0 + 1000);
    return applyDeviceReading(dl, usage(5, 1), T0 + 5000);
  };
  it("falls back to the stored name when labels lack the key", () => {
    const dl = withHub("  Work laptop ");
    expect(deviceView(dl, {}).five_hour!.rows[0].label).toBe("Work laptop");
    expect(deviceView(dl, { "hub:d1": "Live" }).five_hour!.rows[0].label).toBe("Live");
  });
  it("falls back to 'Other device', never a raw hub key", () => {
    expect(deviceView(withHub(), {}).five_hour!.rows[0].label).toBe("Other device");
  });
  it("normalize drops non-string and overlong names", () => {
    const dl = normalizeDeviceLedger({ version: 2, names: { a: "ok", b: 5, c: "x".repeat(81), d: null } });
    expect(dl.names).toEqual({ a: "ok" });
  });
});

describe("always-visible local row, waiting and since", () => {
  it("local row exists with 0 pts in each window; hub rows with 0 pts do not", () => {
    const v = deviceView(start(), {});
    for (const w of ["five_hour", "seven_day"] as const) {
      expect(v[w]!.rows.map((r) => [r.key, r.pts, r.waiting])).toEqual([["local", 0, false]]);
    }
  });
  it("waiting is true while weight is pending (also for sub-threshold hub rows)", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 5, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 5, T0 + 1000);
    const v = deviceView(dl, {}).five_hour!;
    expect(v.rows.map((r) => [r.key, r.waiting]).sort()).toEqual([["hub:d1", true], ["local", true]]);
    dl = applyDeviceReading(dl, usage(4, 1), T0 + 5000);
    expect(deviceView(dl, {}).five_hour!.rows.every((r) => !r.waiting)).toBe(true);
  });
  it("since is set on first sight, kept across readings, reset on a new cycle", () => {
    let dl = start();
    expect(deviceView(dl, {}).five_hour!.trackingSince).toBe(T0);
    dl = applyDeviceReading(dl, usage(3, 1), T0 + 5000);
    expect(deviceView(dl, {}).five_hour!.trackingSince).toBe(T0);
    const R5b = "2026-01-01T19:00:00Z";
    dl = applyDeviceReading(dl, usage(1, 1, R5b), T0 + 9000);
    expect(deviceView(dl, {}).five_hour!.trackingSince).toBe(T0 + 9000);
    expect(deviceView(dl, {}).seven_day!.trackingSince).toBe(T0);
  });
  it("normalizeDeviceLedger tolerates missing/garbage since", () => {
    expect(normalizeDeviceLedger({ version: 2, since: { five_hour: "x", seven_day: 5 } }).since).toEqual({ seven_day: 5 });
    expect(normalizeDeviceLedger({}).since).toEqual({});
  });
});

describe("addSessionActivity (sessions-list evidence)", () => {
  it("session key alone during a rise gets the whole rise, medium confidence", () => {
    let dl = start();
    dl = addSessionActivity(dl, ["session:a"], usage(5, 1), T0 + 4000);
    dl = applyDeviceReading(dl, usage(5, 1), T0 + 5000);
    const r = rowOf(dl, "session:a")!;
    expect(r.pts).toBeCloseTo(5);
    expect(r.confidence).toBe("medium");
    expect(r.label).toBe("Signed-in device");
    conserved(dl, "five_hour", 5);
  });

  it("session key + local reply in the same rise splits, both low", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 10, T0 + 1000);
    dl = addSessionActivity(dl, ["session:a"], usage(8, 0), T0 + 4000);
    dl = applyDeviceReading(dl, usage(8, 0), T0 + 5000);
    expect(rowOf(dl, "local")!.pts).toBeCloseTo(4);
    expect(rowOf(dl, "session:a")!.pts).toBeCloseTo(4);
    expect(rowOf(dl, "local")!.confidence).toBe("low");
    expect(rowOf(dl, "session:a")!.confidence).toBe("low");
  });

  it("no rise leaves the ledger unchanged", () => {
    const dl = start(10, 1);
    expect(addSessionActivity(dl, ["session:a"], usage(10, 1), T0 + 1000)).toBe(dl);
    expect(addSessionActivity(dl, ["session:a"], null, T0 + 1000)).toBe(dl);
    expect(addSessionActivity(dl, ["session:a"], usage(3, 0, "2026-01-01T19:00:00Z", "2026-01-09T10:00:00Z"), T0 + 1000)).toBe(dl);
  });

  it("weight is the mean of others' pending weights, 1 when none", () => {
    let dl = start();
    dl = addDeviceContribution(dl, "local", 10, T0 + 1000);
    dl = addDeviceContribution(dl, "hub:d1", 30, T0 + 1000);
    dl = addSessionActivity(dl, ["session:a"], usage(1, 0), T0 + 2000);
    expect(dl.ledger.pendingW.five_hour!["session:a"]).toBeCloseTo(20);
    const solo = addSessionActivity(start(), ["session:b"], usage(1, 0), T0 + 2000);
    expect(solo.ledger.pendingW.five_hour!["session:b"]).toBeCloseTo(1);
  });

  it("normalizeDeviceLedger keeps/validates method; rememberNames merges", () => {
    const dl = addSessionActivity(start(), ["session:a"], usage(1, 0), T0 + 2000);
    expect(normalizeDeviceLedger(JSON.parse(JSON.stringify(dl))).method).toEqual({ "session:a": "updated" });
    expect(normalizeDeviceLedger({ version: 2, method: { x: "updated", y: "bogus", z: 3 } }).method).toEqual({ x: "updated" });
    expect(normalizeDeviceLedger({ version: 2, method: "junk" }).method).toEqual({});
    const named = rememberNames(dl, { "session:a": " Claude iOS ", "session:b": "" });
    expect(named.names).toEqual({ "session:a": "Claude iOS" });
    const after = applyDeviceReading(addSessionActivity(named, ["session:a"], usage(2, 0), T0 + 3000), usage(2, 0), T0 + 4000);
    expect(rowOf(after, "session:a")!.label).toBe("Claude iOS");
  });
});

describe("applyReadingWithSessions", () => {
  const rd = (u5: number, u7: number, fetchedAt: number) => ({ fetchedAt, ...usage(u5, u7) });

  it("credits a changed session for the rise (activity sees the ledger before the reading)", () => {
    let dl = start();
    dl = applyReadingWithSessions(dl, rd(8, 0, T0 + 5000), ["session:a"], { "session:a": "Claude (iOS)" }, T0 + 5000);
    expect(rowOf(dl, "session:a")!.pts).toBeCloseTo(8);
    expect(rowOf(dl, "session:a")!.label).toBe("Claude (iOS)");
    expect(rowOf(dl, "session:a")!.confidence).toBe("medium");
  });

  it("with no sessions it equals a plain reading", () => {
    const dl = start();
    const a = applyReadingWithSessions(dl, rd(8, 0, T0 + 5000), [], {}, T0 + 5000);
    const b = applyDeviceReading(dl, rd(8, 0, T0 + 5000), T0 + 5000);
    expect(a.ledger).toEqual(b.ledger);
  });
});

describe("baselineWeights", () => {
  const S = T0 - 5 * 3600_000;
  const ev = (ts: number, over: Record<string, unknown> = {}) => ({
    id: String(ts), ts, source: "chrome", deviceId: "me", model: "claude-sonnet-5-5", promptChars: 0, outputChars: 0, thinkingChars: 0,
    promptTokens: 100, outputTokens: 20, estimated: true, status: "ok", kind: "chat", ...over,
  }) as never;
  const base = { events: [], ownDeviceId: "me", hubDevices: [], sessions: {}, window: "five_hour" as const, cycleStartMs: S, now: T0 };
  it("sums local events inside the window and ignores outside / foreign ones", () => {
    const w = baselineWeights({ ...base, events: [ev(S + 1000), ev(S - 1000), ev(T0 + 5000), ev(S + 2000, { deviceId: "other" }), ev(S + 3000, { source: "claude-code" })] });
    expect(w).toEqual({ local: 200 });
  });
  it("hub tokens by window, self excluded", () => {
    const hubDevices: { deviceId: string; source: string; last5hByModel: Record<string, number>; last7dByModel: Record<string, number> }[] = [
      { deviceId: "cc", source: "claude-code", last5hByModel: { "claude-opus-4-5": 10 }, last7dByModel: { "claude-opus-4-5": 100 } },
      { deviceId: "me", source: "chrome", last5hByModel: { x: 999 }, last7dByModel: { x: 999 } },
    ];
    expect(baselineWeights({ ...base, hubDevices })).toEqual({ "hub:cc": 50 });
    expect(baselineWeights({ ...base, hubDevices, window: "seven_day" })).toEqual({ "hub:cc": 500 });
  });
  it("non-current sessions inside the window get the mean weight; outside ones do not", () => {
    const sessions = {
      "session:a": { lastUpdated: new Date(S + 10).toISOString(), current: false },
      "session:old": { lastUpdated: new Date(S - 10).toISOString(), current: false },
    };
    expect(baselineWeights({ ...base, events: [ev(S + 1)], sessions })).toEqual({ local: 200, "session:a": 200 });
    expect(baselineWeights({ ...base, sessions })).toEqual({ "session:a": 1 });
  });
  it("current session gives local the fallback weight when it has no events", () => {
    const sessions = {
      "session:cur": { lastUpdated: new Date(S + 10).toISOString(), current: true },
      "session:b": { lastUpdated: new Date(S + 10).toISOString(), current: false },
    };
    const hubDevices = [{ deviceId: "cc", source: "claude-code", last5hByModel: { s: 40 }, last7dByModel: {} }];
    expect(baselineWeights({ ...base, sessions, hubDevices })).toEqual({ "hub:cc": 40, local: 40, "session:b": 40 });
  });
  it("all-zero stays empty", () => {
    expect(baselineWeights(base)).toEqual({});
    expect(baselineWeights({ ...base, sessions: { "session:old": { lastUpdated: new Date(S - 1).toISOString(), current: true } } })).toEqual({});
  });
});

describe("pre-tracking baseline", () => {
  const W = { local: 3, "hub:cc": 1 };
  it("first sight splits the utilisation, marks rows estimated/low", () => {
    const dl = applyDeviceReading(emptyDeviceLedger(), usage(40, 20), T0, () => W);
    const v = deviceView(dl, {}).five_hour!;
    expect(v.unattributedPts).toBeCloseTo(0);
    const local = v.rows.find((r) => r.key === "local")!;
    expect(local.pts).toBeCloseTo(30);
    expect(local.estimated).toBe(true);
    expect(local.confidence).toBe("low");
    expect(v.rows.find((r) => r.key === "hub:cc")!.pts).toBeCloseTo(10);
    expect(v.baselineEstimated).toBe(true);
  });
  it("later tracked rises make the row mostly measured again", () => {
    let dl = applyDeviceReading(emptyDeviceLedger(), usage(10, 5), T0, () => ({ local: 1 }));
    dl = addDeviceContribution(dl, "local", 10, T0 + 1000);
    dl = applyDeviceReading(dl, usage(40, 5), T0 + 5000);
    const r = rowOf(dl, "local")!;
    expect(r.pts).toBeCloseTo(40);
    expect(r.estimated).toBeUndefined();
    expect(r.confidence).toBe("high");
  });
  it("without a baseline (or with all-zero weights) usage stays Unattributed", () => {
    for (const b of [undefined, () => ({})]) {
      const v = deviceView(applyDeviceReading(emptyDeviceLedger(), usage(40, 20), T0, b), {}).five_hour!;
      expect(v.unattributedPts).toBeCloseTo(40);
      expect(v.rows.every((r) => !r.estimated)).toBe(true);
    }
  });
  it("baselinePts shrink with a utilisation drop and reset with the cycle", () => {
    let dl = applyDeviceReading(emptyDeviceLedger(), usage(40, 20), T0, () => ({ local: 1 }));
    dl = applyDeviceReading(dl, usage(20, 20), T0 + 1000);
    expect(dl.baselinePts.five_hour!.local).toBeCloseTo(20);
    dl = applyDeviceReading(dl, usage(5, 20, "2026-01-01T19:00:00Z"), T0 + 2000);
    expect(dl.baselinePts.five_hour).toEqual({});
  });
  it("survives a JSON round trip", () => {
    const dl = applyDeviceReading(emptyDeviceLedger(), usage(40, 20), T0, () => W);
    expect(normalizeDeviceLedger(JSON.parse(JSON.stringify(dl)))).toEqual(dl);
  });
  it("old (unversioned) ledgers load empty but keep names", () => {
    const old = { ...applyDeviceReading(emptyDeviceLedger(), usage(40, 20), T0), names: { "hub:x": "Desk" } } as Record<string, unknown>;
    delete old.version;
    const n = normalizeDeviceLedger(JSON.parse(JSON.stringify(old)));
    expect(n).toEqual({ ...emptyDeviceLedger(), names: { "hub:x": "Desk" } });
    expect(n.version).toBe(DEVICE_LEDGER_VERSION);
  });
});
