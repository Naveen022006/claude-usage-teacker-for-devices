import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountSource, NOTE_OFFLINE, NOTE_REFRESH, NOTE_SIGN_IN, readCredentials } from "../src/server/accountUsage";
import { buildTrayState } from "../src/server/trayState";

const FAKE = "fake-access-token-for-tests";
let tmp: string;
const credFile = (name: string, exp: number | undefined, sub: string | undefined = "max") => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: FAKE, refreshToken: "fake-refresh", expiresAt: exp, scopes: ["user:inference"], subscriptionType: sub } }));
  return p;
};
const body = { five_hour: { utilization: 42.4, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: 11, resets_at: "2030-01-05T00:00:00Z" }, seven_day_opus: null, seven_day_sonnet: { utilization: 3, resets_at: null } };
const okFetch = ((_u: unknown, init: any) => {
  seen = init.headers;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as unknown as typeof fetch;
let seen: any;

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "um-tray-")); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("account usage source", () => {
  it("parses usage and sends the required headers", async () => {
    const r = await createAccountSource({ trayDir: null, path: credFile("ok.json", Date.now() + 3600_000), fetchFn: okFetch }).poll();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.plan).toBe("max");
    expect(r.usage.windows.map((w) => w.name)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
    expect(seen.Authorization).toBe(`Bearer ${FAKE}`);
    expect(seen["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });
  it("expired token -> refresh note, no request", async () => {
    let called = false;
    const r = await createAccountSource({ trayDir: null, path: credFile("exp.json", Date.now() - 1000), fetchFn: (() => { called = true; return Promise.reject(new Error("x")); }) as any }).poll();
    expect(r).toMatchObject({ kind: "error", note: NOTE_REFRESH });
    expect(called).toBe(false);
  });
  it("401 and 403 -> refresh note", async () => {
    for (const status of [401, 403]) {
      const f = (() => Promise.resolve(new Response("{}", { status }))) as any;
      expect(await createAccountSource({ trayDir: null, path: credFile("a.json", undefined), fetchFn: f }).poll()).toMatchObject({ kind: "error", note: NOTE_REFRESH });
    }
  });
  it("missing file -> sign-in note; network error -> offline note", async () => {
    expect(await createAccountSource({ trayDir: null, path: join(tmp, "nope.json"), fetchFn: okFetch }).poll()).toEqual({ kind: "none", note: NOTE_SIGN_IN });
    const f = (() => Promise.reject(new Error(`boom ${FAKE}`))) as any;
    const r = await createAccountSource({ trayDir: null, path: credFile("n.json", undefined, "pro"), fetchFn: f }).poll();
    expect(r).toMatchObject({ kind: "error", note: NOTE_OFFLINE, plan: "pro" });
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });
  it("tolerates garbage credentials", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json");
    expect(readCredentials(p).status).toBe("invalid");
  });
});

describe("buildTrayState", () => {
  const now = Date.parse("2030-01-01T01:55:00Z");
  const usage = { fetchedAt: now, windows: [{ name: "five_hour", utilization: 42.4, resetsAt: "2030-01-01T05:00:00Z" }, { name: "seven_day", utilization: 11 }] };
  it("builds limits, models, tooltip and icon", () => {
    const s = buildTrayState({
      now, plan: "max", limitsSource: "account", limitsNote: null, accountUsage: usage,
      attribution: { five_hour: { byModel: { "claude-opus-5-5": 30.04, "claude-sonnet-5-5": 12 }, other: 0.4 }, seven_day: { byModel: { "claude-opus-5-5": 8 }, other: 1 } },
      tokensNew5hByModel: { "claude-sonnet-5-5": 48_000, "claude-haiku-4-5": 1200 },
    });
    expect(s.limits.map((l) => l.label)).toEqual(["Session (5h)", "Weekly"]);
    expect(s.limits[0]).toMatchObject({ pct: 42.4, tone: "ok" });
    expect(s.models.map((m) => m.label)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]);
    expect(s.models[0]).toMatchObject({ pct5h: 30, pctWeek: 8, tokens: 0 });
    expect(s.models[1]).toMatchObject({ tokensText: "48k", pctWeek: null });
    expect(s.other).toEqual({ pct5h: 0.4, pctWeek: 1 });
    expect(s.tooltip).toBe("Claude · Session 42% (3h 5m) · Weekly 11%");
    expect(s.iconPct).toBe(42);
    expect(s.iconTone).toBe("ok");
  });
  it("unknown limits", () => {
    const s = buildTrayState({ now, plan: null, limitsSource: null, limitsNote: NOTE_SIGN_IN, accountUsage: null, attribution: {}, tokensNew5hByModel: {} });
    expect(s.limits.map((l) => [l.label, l.pct])).toEqual([["Session (5h)", null], ["Weekly", null]]);
    expect(s.tooltip).toBe("Claude usage · plan limits unavailable");
    expect(s.iconPct).toBeNull();
    expect(s.other).toBeNull();
  });
  it("caps models at 6, tone warn/bad, tooltip <= 127", () => {
    const tokens: Record<string, number> = {};
    for (let i = 0; i < 9; i++) tokens[`claude-model${i}-1`] = i + 1;
    const s = buildTrayState({ now, plan: "pro", limitsSource: "hub", limitsNote: null, accountUsage: { fetchedAt: now, windows: [{ name: "five_hour", utilization: 96 }, { name: "seven_day", utilization: 85 }, { name: "seven_day_opus", utilization: 5 }] }, attribution: {}, tokensNew5hByModel: tokens });
    expect(s.models).toHaveLength(6);
    expect(s.limits.map((l) => l.tone)).toEqual(["bad", "warn", "ok"]);
    expect(s.limits[2].label).toBe("Weekly Opus");
    expect(s.tooltip.length).toBeLessThanOrEqual(127);
  });
});

