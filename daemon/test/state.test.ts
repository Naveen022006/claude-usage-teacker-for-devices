import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, loadConfig, saveConfig, statePath } from "../src/config";
import { loadState, saveState } from "../src/state";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dbcc-"));
  vi.stubEnv("DESKBUDDY_URL", "");
  vi.stubEnv("DESKBUDDY_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("creates defaults on first run and keeps deviceId stable", async () => {
    const a = await loadConfig(dir);
    expect(a.scanIntervalSec).toBe(10);
    expect(a.heartbeatSec).toBe(60);
    expect(a.backfillDays).toBe(7);
    expect(a.deskbuddyUrl).toBe("");
    expect(a.deviceName).toMatch(/-ClaudeCode$/);
    expect(a.desktopDeviceName).toMatch(/-Desktop$/);
    expect(a.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const b = await loadConfig(dir);
    expect(b.deviceId).toBe(a.deviceId);
  });

  it("env overrides url and token without persisting them", async () => {
    await loadConfig(dir);
    vi.stubEnv("DESKBUDDY_URL", "http://x.local");
    vi.stubEnv("DESKBUDDY_TOKEN", "tok");
    const c = await loadConfig(dir);
    expect(c.deskbuddyUrl).toBe("http://x.local");
    expect(c.sharedToken).toBe("tok");
    const onDisk = JSON.parse(await readFile(configPath(dir), "utf8"));
    expect(onDisk.deskbuddyUrl).toBe("");
  });

  it("falls back to default and warns on bad types", async () => {
    await writeFile(configPath(dir), JSON.stringify({ scanIntervalSec: "fast", deskbuddyUrl: 5, backfillDays: 3 }));
    const warn = vi.fn();
    const c = await loadConfig(dir, warn);
    expect(c.scanIntervalSec).toBe(10);
    expect(c.deskbuddyUrl).toBe("");
    expect(c.backfillDays).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("saveConfig merges a partial", async () => {
    const a = await loadConfig(dir);
    await saveConfig({ deskbuddyUrl: "http://d.local" }, dir);
    const b = await loadConfig(dir);
    expect(b.deskbuddyUrl).toBe("http://d.local");
    expect(b.deviceId).toBe(a.deviceId);
  });
});

describe("state", () => {
  it("returns fresh state when missing", async () => {
    const s = await loadState(dir);
    expect(s).toMatchObject({ v: 1, cursors: {}, events: [] });
  });

  it("roundtrips and prunes old events", async () => {
    const now = Date.now();
    const ev = (id: string, ts: number) => ({
      id, ts, source: "claude-code" as const, deviceId: "d", model: "m", promptChars: 0, outputChars: 0,
      thinkingChars: 0, promptTokens: 1, outputTokens: 2, estimated: false, status: "ok" as const, kind: "new" as const,
    });
    const s = await loadState(dir);
    s.cursors["/f"] = { offset: 5, size: 5, mtimeMs: 1 };
    s.events = [ev("new", now), ev("old", now - 40 * 86400e3)];
    await saveState(s, dir, now);
    const r = await loadState(dir);
    expect(r.cursors["/f"].offset).toBe(5);
    expect(r.events.map((e) => e.id)).toEqual(["new"]);
  });

  it("resets cursors and events once when rev is missing, keeps lastSync", async () => {
    const old = { v: 1, cursors: { "/f": { offset: 1, size: 1, mtimeMs: 1 } }, events: [{ id: "a" }], lastSync: { okAt: 5, attemptAt: 6, error: null } };
    await writeFile(statePath(dir), JSON.stringify(old));
    const s = await loadState(dir);
    expect(s).toMatchObject({ v: 1, rev: 2, cursors: {}, events: [], lastSync: { okAt: 5 } });
    await saveState(s, dir);
    s.cursors["/g"] = { offset: 2, size: 2, mtimeMs: 2 };
    await saveState(s, dir);
    expect((await loadState(dir)).cursors["/g"].offset).toBe(2); // not reset again
  });

  it("renames a corrupt file to .bak and starts fresh", async () => {
    await writeFile(statePath(dir), "{not json");
    const s = await loadState(dir);
    expect(s.events).toEqual([]);
    expect(await readFile(statePath(dir) + ".bak", "utf8")).toBe("{not json");
  });
});
