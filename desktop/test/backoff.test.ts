import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountSource, NOTE_OFFLINE, NOTE_RATE_LIMIT, parseRetryAfter } from "../src/server/accountUsage";
import { startServer, type RunningServer } from "../src/server/server";
import { buildTrayState, composeLimitsNote } from "../src/server/trayState";
import type { TrayState } from "../src/shared/tray";

const FAKE = "fake-access-token-for-tests";
const MIN = 60_000;
let tmp: string;
let clock: number;
let calls: number;
let responder: () => Response | Promise<Response>;
let srvs: RunningServer[] = [];
const body = { five_hour: { utilization: 42, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: 11, resets_at: "2030-01-05T00:00:00Z" } };
const okRes = () => new Response(JSON.stringify(body), { status: 200 });
const fetchFn = (() => { calls++; return Promise.resolve(responder()); }) as unknown as typeof fetch;

async function boot(): Promise<RunningServer> {
  const s = await startServer({
    dataDir: join(tmp, "data"), projectsDir: join(tmp, "projects"), distDir: join(tmp, "dist"), hub: null, port: 0,
    credentialsPath: join(tmp, "cred.json"), accountFetch: fetchFn, accountPollMs: 3_600_000, scanIntervalMs: 3_600_000, now: () => clock,
  });
  srvs.push(s);
  await s.limitsRefresh();
  return s;
}
async function tray(s: RunningServer): Promise<TrayState> {
  const r = await fetch(`${s.url}api/tray`);
  return (await r.json()) as TrayState;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "um-bo-"));
  mkdirSync(join(tmp, "dist"));
  writeFileSync(join(tmp, "cred.json"), JSON.stringify({ claudeAiOauth: { accessToken: FAKE, expiresAt: Date.now() + 1e10, subscriptionType: "max" } }));
  // tray-owned sign-in, so notes are not prefixed by the CLI-fallback hint
  mkdirSync(join(tmp, "data", "claude-auth"), { recursive: true });
  writeFileSync(join(tmp, "data", "claude-auth", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: FAKE, expiresAt: Date.now() + 1e10, subscriptionType: "max" } }));
  clock = Date.now();
  calls = 0;
  responder = okRes;
});
afterEach(async () => {
  for (const s of srvs.splice(0)) await s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("account source errors", () => {
  const src = () => createAccountSource({ trayDir: null, path: join(tmp, "cred.json"), fetchFn, now: () => clock });
  it("429 with Retry-After seconds and HTTP date", async () => {
    responder = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
    expect(await src().poll()).toMatchObject({ kind: "error", note: NOTE_RATE_LIMIT, httpStatus: 429, retryAfterMs: 120_000 });
    responder = () => new Response("{}", { status: 429, headers: { "retry-after": new Date(clock + 5 * MIN).toUTCString() } });
    const r = await src().poll();
    expect(r.kind === "error" && r.retryAfterMs! > 4 * MIN && r.retryAfterMs! <= 5 * MIN).toBe(true);
    expect(parseRetryAfter("garbage", 0)).toBeNull();
  });
  it("500 and network throw notes", async () => {
    responder = () => new Response("{}", { status: 500 });
    expect(await src().poll()).toMatchObject({ kind: "error", note: "Anthropic error (HTTP 500)", httpStatus: 500 });
    responder = () => { throw new Error(`boom ${FAKE}`); };
    const r = await src().poll();
    expect(r).toMatchObject({ kind: "error", note: NOTE_OFFLINE });
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });
});

describe("server backoff and persistence", () => {
  it("exponential backoff 2,4,8,15,15 and reset on success; skips polls while backing off", async () => {
    responder = () => new Response("{}", { status: 503 });
    const s = await boot();
    expect(calls).toBe(1);
    for (const m of [2, 4, 8, 15, 15]) {
      await s.limitsRefresh(); // still in backoff -> skipped
      expect(calls).toBe(srvCalls());
      clock += m * MIN - 1;
      const before = calls;
      await s.limitsRefresh();
      expect(calls).toBe(before); // 1 ms short of the window
      clock += 1;
      await s.limitsRefresh();
      expect(calls).toBe(before + 1);
    }
    responder = okRes;
    clock += 15 * MIN;
    await s.limitsRefresh();
    expect((await tray(s)).limitsNote).toBeNull();
    responder = () => new Response("{}", { status: 503 });
    await s.limitsRefresh(); // not in backoff after success
    const t = await tray(s);
    expect(t.limitsNote).toContain("HTTP 503");
    clock += 2 * MIN; // first step again
    const c = calls;
    await s.limitsRefresh();
    expect(calls).toBe(c + 1);
  });
  function srvCalls(): number { return calls; }

  it("429 Retry-After wins, note shows remaining minutes, no reads during backoff", async () => {
    responder = () => new Response("{}", { status: 429, headers: { "retry-after": "240" } });
    const s = await boot();
    const t = await tray(s);
    expect(t.limitsNote).toBe("Anthropic rate limit \u2014 retrying in 4m");
    clock += MIN;
    expect((await tray(s)).limitsNote).toBe("Anthropic rate limit \u2014 retrying in 3m");
    const c = calls;
    await s.limitsRefresh();
    expect(calls).toBe(c);
  });

  it("persists last good reading, loads it on restart, stale note, no token", async () => {
    const s1 = await boot();
    expect((await tray(s1)).limits[0].pct).toBe(42);
    await s1.close();
    srvs = [];
    const file = readFileSync(join(tmp, "data", "account.json"), "utf8");
    expect(file).not.toContain(FAKE);
    clock += 30 * MIN;
    responder = () => new Response("{}", { status: 500 });
    const s2 = await startServer({
      dataDir: join(tmp, "data"), projectsDir: join(tmp, "projects"), distDir: join(tmp, "dist"), hub: null, port: 0,
      credentialsPath: join(tmp, "cred.json"), accountFetch: fetchFn, accountPollMs: 3_600_000, scanIntervalMs: 3_600_000, now: () => clock,
    });
    srvs.push(s2);
    const t = await tray(s2);
    expect(t.limits[0].pct).toBe(42);
    expect(t.limitsNote).toBe("Anthropic error (HTTP 500) \xb7 30m old");
    expect(JSON.stringify(t)).not.toContain(FAKE);
  });

  it("composeLimitsNote combines error and age", () => {
    const usage = { fetchedAt: 0, windows: [] };
    expect(composeLimitsNote({ now: 5 * MIN, limitsNote: null, accountUsage: usage })).toBeNull();
    expect(composeLimitsNote({ now: 20 * MIN, limitsNote: "Anthropic error (HTTP 500)", accountUsage: usage })).toBe("Anthropic error (HTTP 500) \xb7 20m old");
    expect(buildTrayState({ now: 1, plan: null, limitsSource: null, limitsNote: null, accountUsage: null, attribution: {} as any, tokensNew5hByModel: {} }).limitsNote).toBeNull();
  });
});
