import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChromeAccounts, CHROME_MAX_AGE_MS, createDesktopLimitsSource, NOTE_WAITING } from "../src/server/desktopLimits";
import { startServer } from "../src/server/server";
import { buildTrayState } from "../src/server/trayState";
import type { TrayState } from "../src/shared/tray";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "um-dl-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const rep = (orgId: string, plan: string | null, pct: number, fetchedAt: number) => ({
  v: 1,
  orgId,
  plan,
  usage: { fetchedAt, windows: [{ name: "five_hour", utilization: pct, resetsAt: "2030-01-01T00:00:00Z" }, { name: "seven_day", utilization: pct / 2 }] },
});

describe("plan limits of the Claude Desktop account, reported by the Chrome extension", () => {
  it("waits (never reads credentials) until the extension reports", async () => {
    const src = createDesktopLimitsSource();
    expect(await src.poll()).toEqual({ kind: "none", note: NOTE_WAITING });
    expect(src.inspect().accountKind).toBe("desktop");
  });

  it("validates reports and picks the highest plan, then the newest", () => {
    const c = new ChromeAccounts(null);
    expect(c.accept({ orgId: "../x", usage: {} }, 1)).toBe(false);
    expect(c.accept(rep("org-free", "free", 10, 100), 1000)).toBe(true);
    expect(c.accept(rep("org-pro", "pro", 50, 200), 1000)).toBe(true);
    expect(c.accept(rep("org-max", "max", 30, 150), 1000)).toBe(true);
    expect(c.best(2000)?.orgId).toBe("org-max");
    expect(c.accept(rep("org-max", "max", 20, 100), 1000)).toBe(true); // older reading ignored
    expect(c.best(2000)?.usage.windows[0].utilization).toBe(30);
    expect(c.best(1000 + CHROME_MAX_AGE_MS + 1)).toBeNull(); // too old
  });

  it("persists across restarts", () => {
    const file = join(tmp, "chrome.json");
    new ChromeAccounts(file).accept(rep("org-max", "max", 42, 100), 1000);
    expect(new ChromeAccounts(file).best(2000)?.plan).toBe("max");
  });

  it("server accepts reports only from extension origins and shows them as the Session / Weekly rows", async () => {
    mkdirSync(join(tmp, "dist"), { recursive: true });
    const s = await startServer({ dataDir: join(tmp, "data"), projectsDir: join(tmp, "projects"), distDir: join(tmp, "dist"), hub: null, port: 0, accountPollMs: 3_600_000, scanIntervalMs: 3_600_000 });
    try {
      await s.limitsRefresh();
      let t = (await (await fetch(`${s.url}api/tray`)).json()) as TrayState;
      expect(t.limitsNote).toBe(NOTE_WAITING);
      expect(t.limits.every((l) => l.pct === null)).toBe(true);

      const url = new URL("/api/local-account", s.url).href;
      const body = JSON.stringify(rep("org-max", "max", 64, Date.now()));
      expect((await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(403);
      expect((await fetch(url, { method: "POST", body: "{bad", headers: { "content-type": "application/json", origin: "chrome-extension://abc" } })).status).toBe(400);
      expect((await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", origin: "chrome-extension://abc" } })).status).toBe(200);
      await s.limitsRefresh();
      t = (await (await fetch(`${s.url}api/tray`)).json()) as TrayState;
      expect(t.plan).toBe("max");
      expect(t.accountKind).toBe("desktop");
      expect(t.limitsNote).toBeNull();
      expect(t.limits.find((l) => l.label === "Session (5h)")?.pct).toBe(64);
      expect(t.limits.find((l) => l.label === "Weekly")?.pct).toBe(32);
    } finally {
      await s.close();
    }
  });
});

describe("without plan limits", () => {
  it("models show exact Desktop tokens per 5h / week and replies — no %", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const s = buildTrayState({
      now,
      plan: null,
      limitsSource: null,
      limitsNote: NOTE_WAITING,
      accountUsage: null,
      // stale attribution from an earlier source must not leak into the rows
      attribution: { five_hour: { byModel: { "claude-opus-5-5": 91 }, other: 0 }, seven_day: { byModel: { "claude-opus-5-5": 13 }, other: 0 } },
      tokensNew5hByModel: { "claude-opus-5-5": 1200 },
      usage5hByModel: { "claude-opus-5-5": { tokens: 1200, messages: 3 } },
      usage7dByModel: { "claude-opus-5-5": { tokens: 48_000, messages: 40 }, "claude-sonnet-5-5": { tokens: 12_000, messages: 9 } },
      accountKind: "desktop",
    });
    expect(s.modelHeader).toEqual(["5h tok", "Week tok", "Replies"]);
    expect(s.models.map((m) => [m.label, m.text5h, m.textWeek, m.tokensText, m.pct5h, m.pctWeek, m.barPct])).toEqual([
      ["Opus 5.5", "1.2k", "48k", "40", null, null, 100],
      ["Sonnet 5.5", "—", "12k", "9", null, null, 25],
    ]);
    expect(s.other).toBeNull();
    expect(s.limits.every((l) => l.pct === null)).toBe(true);
    expect(s.limitsNote).toBe(NOTE_WAITING);
    expect(s.tooltip).toBe("Claude Desktop · 5h 1.2k tok · week 60k tok");
    expect(s.iconPct).toBeNull();
  });
});
