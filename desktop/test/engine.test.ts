import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../src/main/engine";
import type { AccountUsage } from "../../src/shared/types";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
let data: string;
let proj: string;
let file: string;

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "eng-data-"));
  proj = await mkdtemp(join(tmpdir(), "eng-proj-"));
  await mkdir(join(proj, "p"), { recursive: true });
  file = join(proj, "p", "s.jsonl");
});
afterEach(async () => {
  await rm(data, { recursive: true, force: true });
  await rm(proj, { recursive: true, force: true });
});

function line(id: string, o: { model?: string; ago?: number; out?: number; input?: number; cr?: number; cc?: number; entry?: string } = {}) {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(NOW - (o.ago ?? 60_000)).toISOString(),
      entrypoint: o.entry ?? "cli",
      message: {
        id,
        model: o.model ?? "claude-sonnet-5-5",
        content: [{ type: "text", text: "lorem" }],
        usage: { input_tokens: o.input ?? 100, cache_creation_input_tokens: o.cc ?? 0, cache_read_input_tokens: o.cr ?? 0, output_tokens: o.out ?? 50 },
      },
    }) + "\n"
  );
}

const usage = (five: number, at = NOW): AccountUsage => ({
  fetchedAt: at,
  windows: [
    { name: "five_hour", utilization: five, resetsAt: "2026-10-10T15:00:00Z" },
    { name: "seven_day", utilization: five, resetsAt: "2026-10-15T15:00:00Z" },
  ] as any,
});

const BOTH = ["desktop", "claude-code"] as const;
const mk = (sources: ("desktop" | "claude-code")[] = [...BOTH]) => createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, sources, now: () => NOW });
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("engine", () => {
  it("backfill creates no contributions; a new line does and fires onReplies", async () => {
    await writeFile(file, line("old1", { ago: 3 * DAY }));
    const e = mk();
    let replies = 0;
    e.onReplies(() => replies++);
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(10), NOW); // baseline
    e.applyAccountUsage(usage(14), NOW + 1000);
    // nothing pending at backfill: delta goes to other
    expect(e.snapshot().attribution.five_hour!.byModel).toEqual({});
    expect(e.snapshot().attribution.five_hour!.other).toBeCloseTo(14);
    expect(replies).toBe(0);

    await appendFile(file, line("new1", { model: "claude-opus-4-1" }));
    await e.refreshNow();
    await sleep(1300);
    expect(replies).toBe(1);
    e.applyAccountUsage(usage(18), NOW + 2000);
    const a = e.snapshot().attribution.five_hour!;
    expect(a.byModel["claude-opus-4-1"]).toBeCloseTo(4);
    expect(a.other).toBeCloseTo(14);
    e.stop();
  });

  it("splits delta between models by weight", async () => {
    await writeFile(file, line("old1", { ago: 3 * DAY }));
    const e = mk();
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(10), NOW);
    await appendFile(file, line("a", { model: "claude-sonnet-5-5", input: 100, out: 50 }) + line("b", { model: "claude-sonnet-5-5", input: 100, out: 50 }) + line("c", { model: "claude-haiku-4-5", input: 100, out: 50 }));
    await e.refreshNow();
    e.applyAccountUsage(usage(13.3), NOW + 1000);
    const a = e.snapshot().attribution.five_hour!;
    expect(a.byModel["claude-sonnet-5-5"]).toBeCloseTo(3.3 * (2 / 2.3), 5);
    expect(a.byModel["claude-haiku-4-5"]).toBeCloseTo(3.3 * (0.3 / 2.3), 5);
    e.stop();
  });

  it("weight discounts cache reads", async () => {
    await writeFile(file, line("old1", { ago: 3 * DAY }));
    const e = mk();
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(10), NOW);
    // x: huge cache read, y: same output, no cache. Weights: x = 100+0.1*1_000_000 + 250 ; y = 100 + 250 -> not 1M+.
    await appendFile(file, line("x", { model: "claude-sonnet-5-5", input: 100, cr: 10_000, out: 50 }) + line("y", { model: "claude-haiku-4-5", input: 100, out: 50 }));
    await e.refreshNow();
    e.applyAccountUsage(usage(12), NOW + 1000);
    const a = e.snapshot().attribution.five_hour!;
    const wx = 100 + 0.1 * 10_000 + 250; // 1350 * 1
    const wy = (100 + 250) * 0.3; // 105
    expect(a.byModel["claude-sonnet-5-5"]).toBeCloseTo(2 * (wx / (wx + wy)), 4);
    e.stop();
  });

  it("splits sources desktop vs claude-code and totals tokens5hByModel", async () => {
    await writeFile(file, line("a", { entry: "cli", input: 10, out: 5 }) + line("b", { entry: "claude-desktop", input: 20, out: 7 }) + line("c", { entry: "claude-vscode", input: 1, out: 1 }));
    const e = mk();
    e.start();
    await e.refreshNow();
    const s = e.snapshot();
    const by = Object.fromEntries(s.local.map((l) => [l.source, l.aggregates.last5h.messages]));
    expect(by).toEqual({ "claude-code": 2, desktop: 1 });
    expect(s.tokens5hByModel["claude-sonnet-5-5"]).toBe(15 + 27 + 2);
    expect(s.scan.lastScanAt).toBe(NOW);
    expect(s.scan.filesRead).toBe(1);
    e.stop();
  });

  it("persists across restarts (no re-backfill, ledger kept)", async () => {
    await writeFile(file, line("old1", { ago: 3 * DAY }));
    const e1 = mk();
    e1.start();
    await e1.refreshNow();
    e1.applyAccountUsage(usage(10), NOW);
    e1.stop();
    const saved = JSON.parse(await readFile(join(data, "engine-state.json"), "utf8"));
    expect(saved.v).toBe(1);
    expect(saved.events).toHaveLength(1);
    expect((await readdir(data)).some((f) => f.endsWith(".tmp"))).toBe(false);

    await appendFile(file, line("new1"));
    const e2 = mk();
    e2.start();
    expect(e2.snapshot().attribution.five_hour!.other).toBeCloseTo(10);
    await e2.refreshNow();
    expect(e2.snapshot().local[0].aggregates.last5h.messages).toBe(1);
    e2.applyAccountUsage(usage(15), NOW + 1000);
    expect(e2.snapshot().attribution.five_hour!.byModel["claude-sonnet-5-5"]).toBeCloseTo(5);
    e2.stop();
  });

  it("recovers from a corrupt state file", async () => {
    await writeFile(join(data, "engine-state.json"), "{not json");
    await writeFile(file, line("a"));
    const e = mk();
    e.start();
    await e.refreshNow();
    expect((await readdir(data)).includes("engine-state.json.bak")).toBe(true);
    expect(e.snapshot().local[0].aggregates.last5h.messages).toBe(1);
    e.stop();
  });

  it("resetAttribution clears the ledger", async () => {
    const e = mk();
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(10), NOW);
    expect(e.snapshot().attribution.five_hour).toBeDefined();
    e.resetAttribution();
    expect(e.snapshot().attribution).toEqual({});
    e.stop();
  });
});

describe("new tokens (cache reads excluded)", () => {
  it("tokensNew5hByModel = prompt - cacheRead + output", async () => {
    await writeFile(file, line("m1", { input: 100, cc: 50, cr: 1000, out: 20 }));
    const e = mk();
    e.start();
    await e.refreshNow();
    const snap = e.snapshot();
    e.stop();
    expect(snap.tokensNew5hByModel["claude-sonnet-5-5"]).toBe(100 + 50 + 20);
  });
});

describe("desktop-only sources and baseline split", () => {
  it("defaults to desktop events only (aggregates, tokens, attribution)", async () => {
    await writeFile(file, line("a", { entry: "cli", input: 10, out: 5 }) + line("b", { entry: "claude-desktop", input: 20, out: 7 }));
    const e = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    e.start();
    await e.refreshNow();
    const s = e.snapshot();
    expect(s.local.map((l) => l.source)).toEqual(["desktop"]);
    expect(s.tokens5hByModel["claude-sonnet-5-5"]).toBe(27);
    expect(s.tokensNew5hByModel["claude-sonnet-5-5"]).toBe(27);
    e.applyAccountUsage(usage(10), NOW);
    await appendFile(file, line("c", { entry: "cli", model: "claude-opus-4-1" }));
    await e.refreshNow();
    e.applyAccountUsage(usage(14), NOW + 1000);
    expect(e.snapshot().attribution.five_hour!.byModel["claude-opus-4-1"]).toBeUndefined();
    e.stop();
  });

  it("splits the first reading across window events by weight and flags it estimated", async () => {
    await writeFile(
      file,
      line("s1", { entry: "claude-desktop", model: "claude-sonnet-5-5", input: 100, out: 50, ago: 60_000 }) +
        line("o1", { entry: "claude-desktop", model: "claude-opus-4-1", input: 100, out: 50, ago: 120_000 }) +
        line("cc", { entry: "cli", model: "claude-haiku-4-5", ago: 60_000 }) +
        line("old", { entry: "claude-desktop", model: "claude-haiku-4-5", ago: 3 * DAY }),
    );
    const e = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(60), NOW);
    const a = e.snapshot().attribution.five_hour!;
    expect(a.byModel["claude-sonnet-5-5"]).toBeCloseTo(10);
    expect(a.byModel["claude-opus-4-1"]).toBeCloseTo(50);
    expect(a.byModel["claude-haiku-4-5"]).toBeUndefined();
    expect(a.other).toBe(0);
    expect(a.baselineEstimated).toBe(true);
    e.stop();
  });

  it("no events in window -> other, not estimated", async () => {
    await writeFile(file, line("old", { entry: "claude-desktop", ago: 3 * DAY }));
    const e = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    e.start();
    await e.refreshNow();
    e.applyAccountUsage(usage(20), NOW);
    const a = e.snapshot().attribution.five_hour!;
    expect(a.other).toBeCloseTo(20);
    expect(a.baselineEstimated).toBeUndefined();
    e.stop();
  });

  it("migrates an old ledger once (events kept)", async () => {
    await writeFile(file, line("d1", { entry: "claude-desktop" }));
    const old = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    old.start();
    await old.refreshNow();
    old.applyAccountUsage(usage(10), NOW);
    old.stop();
    const f = join(data, "engine-state.json");
    const saved = JSON.parse(await readFile(f, "utf8"));
    expect(saved.ledgerRev).toBe(2);
    // simulate pre-migration state: baseline in other, no rev
    delete saved.ledgerRev;
    saved.ledger.windows.five_hour.byModel = {};
    saved.ledger.windows.five_hour.other = 10;
    await writeFile(f, JSON.stringify(saved));
    const e = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    e.start();
    expect(e.snapshot().attribution).toEqual({});
    e.applyAccountUsage(usage(10), NOW + 1000);
    expect(e.snapshot().attribution.five_hour!.byModel["claude-sonnet-5-5"]).toBeCloseTo(10);
    e.stop();
    const again = createEngine({ dataDir: data, projectsDir: proj, scanIntervalMs: 3_600_000, now: () => NOW });
    again.start();
    expect(again.snapshot().attribution.five_hour!.byModel["claude-sonnet-5-5"]).toBeCloseTo(10);
    again.stop();
  });
});
