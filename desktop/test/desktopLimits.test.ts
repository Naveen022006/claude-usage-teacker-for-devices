import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesktopLimitsSource, LIMITS_FILE, NOTE_WAITING, readDesktopLimits } from "../src/server/desktopLimits";
import { startServer, type RunningServer } from "../src/server/server";
import { composeLimitsNote } from "../src/server/trayState";
import { isDesktopSession, run, statusText, toLimits } from "../src/statusline/statusline";
import type { TrayState } from "../src/shared/tray";

const MIN = 60_000;
let tmp: string;
const input = (five: number, week: number) =>
  JSON.stringify({ session_id: "s", transcript_path: "none", model: { id: "claude-opus-5-5" }, rate_limits: { five_hour: { used_percentage: five, resets_at: 1_900_000_000 }, seven_day: { used_percentage: week, resets_at: 1_900_500_000 } } });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "um-dl-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("statusLine script (Claude Desktop only)", () => {
  it("records limits for Claude Desktop sessions and prints a short line", () => {
    const env = { APPDATA: tmp, CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
    expect(run(input(42.4, 11), env, 1000)).toBe("Session 42% · Weekly 11%");
    const saved = JSON.parse(readFileSync(join(tmp, "UsageMeterDesktop", LIMITS_FILE), "utf8"));
    expect(saved.fetchedAt).toBe(1000);
    expect(saved.windows).toEqual([
      { name: "five_hour", utilization: 42.4, resetsAt: new Date(1_900_000_000_000).toISOString() },
      { name: "seven_day", utilization: 11, resetsAt: new Date(1_900_500_000_000).toISOString() },
    ]);
  });

  it("ignores Claude Code CLI sessions completely (no output, no file)", () => {
    for (const e of ["cli", "claude-vscode", "sdk-ts"]) {
      expect(run(input(42, 11), { APPDATA: tmp, CLAUDE_CODE_ENTRYPOINT: e })).toBe("");
    }
    expect(() => readFileSync(join(tmp, "UsageMeterDesktop", LIMITS_FILE))).toThrow();
  });

  it("falls back to the transcript's entrypoint when the env var is absent", () => {
    const t = join(tmp, "t.jsonl");
    writeFileSync(t, '{"type":"user","entrypoint":"cli"}\n{"type":"assistant","entrypoint":"claude-desktop"}\n');
    expect(isDesktopSession({ transcript_path: t }, {})).toBe(true);
    writeFileSync(t, '{"type":"assistant","entrypoint":"cli"}\n');
    expect(isDesktopSession({ transcript_path: t }, {})).toBe(false);
    expect(isDesktopSession({ transcript_path: join(tmp, "missing.jsonl") }, {})).toBe(false);
  });

  it("is safe with garbage, missing rate limits and odd values", () => {
    const env = { APPDATA: tmp, CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
    expect(run("not json", env)).toBe("");
    expect(run("{}", env)).toBe("");
    expect(toLimits({ rate_limits: { five_hour: { used_percentage: "x" } } }, 1)).toBeNull();
    expect(toLimits({ rate_limits: { five_hour: { used_percentage: 250 } } }, 1)?.windows[0].utilization).toBe(100);
    expect(statusText(null)).toBe("");
  });
});

describe("desktop limits source", () => {
  it("reads the file; waits when missing or malformed", async () => {
    const src = createDesktopLimitsSource({ dataDir: tmp });
    expect(await src.poll()).toEqual({ kind: "none", note: NOTE_WAITING });
    writeFileSync(join(tmp, LIMITS_FILE), "{bad");
    expect(readDesktopLimits(join(tmp, LIMITS_FILE))).toBeNull();
    writeFileSync(join(tmp, LIMITS_FILE), JSON.stringify({ v: 1, fetchedAt: 5, windows: [{ name: "five_hour", utilization: 30 }, { name: "nope", utilization: 1 }] }));
    const r = await src.poll();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.accountKind).toBe("desktop");
      expect(r.usage.windows).toEqual([{ name: "five_hour", utilization: 30 }]);
    }
  });
});

describe("server with Claude Desktop limits", () => {
  let srv: RunningServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it("shows Desktop limits in the tray, no CLI hint, and applies each reading once", async () => {
    const data = join(tmp, "data");
    mkdirSync(join(tmp, "dist"), { recursive: true });
    srv = await startServer({ dataDir: data, projectsDir: join(tmp, "projects"), distDir: join(tmp, "dist"), hub: null, port: 0, accountPollMs: 3_600_000, scanIntervalMs: 3_600_000 });
    await srv.limitsRefresh();
    let t = (await (await fetch(`${srv.url}api/tray`)).json()) as TrayState;
    expect(t.limitsNote).toBe(NOTE_WAITING);
    expect(t.limits.every((l) => l.pct === null)).toBe(true);

    run(input(37, 9), { APPDATA: tmp.replace(/[\\/]$/, ""), CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, Date.now());
    // statusline writes to <APPDATA>/UsageMeterDesktop; point the server's dataDir file at it
    writeFileSync(join(data, LIMITS_FILE), readFileSync(join(tmp, "UsageMeterDesktop", LIMITS_FILE)));
    await srv.limitsRefresh();
    t = (await (await fetch(`${srv.url}api/tray`)).json()) as TrayState;
    expect(t.accountKind).toBe("desktop");
    expect(t.limitsNote).toBeNull();
    expect(t.limits.find((l) => l.label === "Session (5h)")?.pct).toBe(37);
    expect(t.limits.find((l) => l.label === "Weekly")?.pct).toBe(9);
  });

  it("composeLimitsNote adds the age of an old reading", () => {
    const usage = { fetchedAt: 0, windows: [] };
    expect(composeLimitsNote({ now: 5 * MIN, limitsNote: null, accountUsage: usage })).toBeNull();
    expect(composeLimitsNote({ now: 30 * MIN, limitsNote: null, accountUsage: usage })).toMatch(/30m/);
  });
});
