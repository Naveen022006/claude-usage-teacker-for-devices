import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountSource, NOTE_CLI, NOTE_REFRESH, NOTE_TRAY_SIGN_IN, SILENT_REFRESH_MIN_GAP_MS } from "../src/server/accountUsage";
import { startServer, type RunningServer } from "../src/server/server";
import type { TrayState } from "../src/shared/tray";

const CLI_TOKEN = "fake-cli-token-for-tests";
const TRAY_TOKEN = "fake-tray-token-for-tests";
const MIN = 60_000;
let tmp: string;
let clock: number;
let seenAuth: string[];
let status: number;
let srvs: RunningServer[] = [];
const body = { five_hour: { utilization: 42, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: 11, resets_at: "2030-01-05T00:00:00Z" } };
const fetchFn = ((_u: string, init: any) => {
  seenAuth.push(String(init.headers.Authorization));
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}) as unknown as typeof fetch;

const cliFile = () => join(tmp, "cli", ".credentials.json");
const trayDir = () => join(tmp, "data", "claude-auth");
function writeCreds(file: string, token: string, sub: string, expiresAt: number, account?: { accountUuid: string }): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, subscriptionType: sub } }));
  if (account) writeFileSync(join(file, "..", ".claude.json"), JSON.stringify({ oauthAccount: account }));
}
async function boot(spawnFn?: (d: string) => Promise<void>): Promise<RunningServer> {
  const s = await startServer({
    dataDir: join(tmp, "data"), projectsDir: join(tmp, "projects"), distDir: join(tmp, "dist"), hub: null, port: 0,
    credentialsPath: cliFile(), accountFetch: fetchFn, accountSpawn: spawnFn, accountPollMs: 3_600_000, scanIntervalMs: 3_600_000, now: () => clock,
  });
  srvs.push(s);
  await s.limitsRefresh();
  return s;
}
const tray = async (s: RunningServer) => (await (await fetch(`${s.url}api/tray`)).json()) as TrayState;
const post = async (s: RunningServer, b: unknown) => ((await (await fetch(`${s.url}api/request`, { method: "POST", body: JSON.stringify(b) })).json()) as { result: any }).result;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "um-auth-"));
  mkdirSync(join(tmp, "dist"));
  clock = Date.now();
  seenAuth = [];
  status = 200;
  writeCreds(cliFile(), CLI_TOKEN, "pro", clock + 1e10);
});
afterEach(async () => {
  for (const s of srvs.splice(0)) await s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("credentials preference", () => {
  it("uses the CLI account (with a hint note) when there is no tray login", async () => {
    const s = await boot();
    const t = await tray(s);
    expect(seenAuth).toEqual([`Bearer ${CLI_TOKEN}`]);
    expect(t.accountKind).toBe("cli");
    expect(t.plan).toBe("pro");
    expect(t.limitsNote).toBe(NOTE_CLI);
    expect(t.limits[0].pct).toBe(42);
    expect(await post(s, { type: "auth-status" })).toEqual({ accountKind: "cli", plan: "pro", signedIn: false });
  });

  it("prefers the tray login, plan from its subscriptionType, no hint note", async () => {
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10);
    const s = await boot();
    const t = await tray(s);
    expect(seenAuth).toEqual([`Bearer ${TRAY_TOKEN}`]);
    expect(t).toMatchObject({ accountKind: "tray", plan: "max", limitsNote: null });
    expect(await post(s, { type: "auth-status" })).toEqual({ accountKind: "tray", plan: "max", signedIn: true });
  });

  it("falls back to the CLI file when the tray file is unparseable", async () => {
    mkdirSync(trayDir(), { recursive: true });
    writeFileSync(join(trayDir(), ".credentials.json"), "{not json");
    const s = await boot();
    expect((await tray(s)).accountKind).toBe("cli");
  });

  it("combines the CLI hint with an error note", async () => {
    status = 500;
    const t = await tray(await boot());
    expect(t.limitsNote).toBe(`Anthropic error (HTTP 500) \xb7 ${NOTE_CLI}`);
  });
});

describe("expired tray credentials", () => {
  it("runs one silent refresh, then picks up the refreshed credentials", async () => {
    const f = join(trayDir(), ".credentials.json");
    writeCreds(f, "old-" + TRAY_TOKEN, "max", clock - MIN);
    const dirs: string[] = [];
    const spawnFn = async (d: string) => { dirs.push(d); writeCreds(f, TRAY_TOKEN, "max", clock + 1e10); };
    const s = await boot(spawnFn);
    expect(dirs).toEqual([trayDir()]);
    expect(seenAuth).toEqual([`Bearer ${TRAY_TOKEN}`]);
    expect(await tray(s)).toMatchObject({ accountKind: "tray", limitsNote: null });
  });

  it("shows the sign-in-again note when refresh does not help, and refreshes at most once per 10 min", async () => {
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock - MIN);
    let spawned = 0;
    const s = await boot(async () => { spawned++; });
    expect((await tray(s)).limitsNote).toBe(NOTE_TRAY_SIGN_IN);
    expect(seenAuth).toEqual([]);
    expect(spawned).toBe(1);
    clock += 5 * MIN;
    await s.limitsRefresh();
    expect(spawned).toBe(1);
    clock += 5 * MIN + 1;
    await s.limitsRefresh();
    expect(spawned).toBe(2);
    expect((await tray(s)).limitsNote).toBe(NOTE_TRAY_SIGN_IN);
  });

  it("401 with the tray token also triggers the silent refresh (rate limited) and then the note", async () => {
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10);
    status = 401;
    let spawned = 0;
    const src = createAccountSource({ path: cliFile(), trayDir: trayDir(), fetchFn, now: () => clock, spawnFn: async () => { spawned++; } });
    expect(await src.poll()).toMatchObject({ kind: "error", note: NOTE_TRAY_SIGN_IN, accountKind: "tray" });
    expect(await src.poll()).toMatchObject({ kind: "error", note: NOTE_TRAY_SIGN_IN });
    expect(spawned).toBe(1);
    clock += SILENT_REFRESH_MIN_GAP_MS;
    await src.poll();
    expect(spawned).toBe(2);
  });

  it("CLI 401 keeps the old note and never spawns", async () => {
    status = 401;
    let spawned = 0;
    const src = createAccountSource({ path: cliFile(), trayDir: trayDir(), fetchFn, now: () => clock, spawnFn: async () => { spawned++; } });
    expect(await src.poll()).toMatchObject({ kind: "error", note: NOTE_REFRESH });
    expect(spawned).toBe(0);
  });
});

describe("account change", () => {
  it("resets the attribution ledger when the signed-in account changes, keeps it otherwise", async () => {
    const s = await boot();
    let resets = 0;
    const orig = s.engine.resetAttribution.bind(s.engine);
    s.engine.resetAttribution = () => { resets++; orig(); };
    await post(s, { type: "refresh" });
    expect(resets).toBe(0); // same account
    // token rotation of the same account: no reset
    writeCreds(cliFile(), "rotated-" + CLI_TOKEN, "pro", clock + 1e10);
    await s.limitsRefresh();
    expect(resets).toBe(0);
    // tray login appears (different account) -> reset
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10, { accountUuid: "acct-max" });
    await post(s, { type: "refresh" });
    expect(resets).toBe(1);
    expect((await tray(s)).accountKind).toBe("tray");
    // another tray account (identity from .claude.json) -> reset again
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10, { accountUuid: "acct-other" });
    await post(s, { type: "refresh" });
    expect(resets).toBe(2);
  });

  it("a sign-in change bypasses a running backoff once", async () => {
    status = 500;
    const s = await boot();
    const n = seenAuth.length;
    await post(s, { type: "refresh" });
    expect(seenAuth.length).toBe(n); // still backing off, nothing changed
    status = 200;
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10);
    await post(s, { type: "refresh" });
    expect(seenAuth.length).toBe(n + 1);
    expect((await tray(s)).limits[0].pct).toBe(42);
  });
});

describe("no secrets", () => {
  it("state, tray and auth-status never contain tokens; account.json holds none", async () => {
    writeCreds(join(trayDir(), ".credentials.json"), TRAY_TOKEN, "max", clock + 1e10, { accountUuid: "acct-max" });
    const s = await boot();
    const all = JSON.stringify([await tray(s), await post(s, { type: "auth-status" }), await post(s, { type: "get-state" })]);
    for (const tok of [TRAY_TOKEN, CLI_TOKEN]) expect(all).not.toContain(tok);
    const file = readFileSync(join(tmp, "data", "account.json"), "utf8");
    for (const tok of [TRAY_TOKEN, CLI_TOKEN, "acct-max"]) expect(file).not.toContain(tok);
  });
});
