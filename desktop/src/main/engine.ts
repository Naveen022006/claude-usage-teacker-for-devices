// Usage engine: incremental local transcript scan (reused daemon scanner) + per-model attribution ledger.
// Never reads or keeps message content - only ids, models, timestamps and token counts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountUsage, UsageEvent } from "../../../src/shared/types";
import { computeAggregates, pruneEvents } from "../../../src/shared/aggregate";
import { addContribution, applyReading, attributionView, emptyLedger, normalizeLedger, replyWeight, type Ledger } from "../../../src/shared/attribution";
import { scan } from "../../../daemon/src/scanner";
import { mergeEvents } from "../../../daemon/src/transcript";
import type { Cursors } from "../../../daemon/src/contracts";
import type { DesktopState } from "../shared/ipc";

export interface Engine {
  start(): void;
  stop(): void;
  applyAccountUsage(u: AccountUsage, now: number): void;
  resetAttribution(): void;
  refreshNow(): Promise<void>;
  snapshot(): Pick<DesktopState, "attribution" | "local" | "tokens5hByModel" | "scan"> & { tokensNew5hByModel: Record<string, number> };
  onChange(cb: () => void): () => void;
  onReplies(cb: () => void): () => void;
}

interface Persisted {
  v: 1;
  cursors: Cursors;
  events: UsageEvent[];
  ledger: Ledger;
  ledgerRev?: number;
}

const DAY = 24 * 3600_000;
const LIMITS = { retentionMs: 8 * DAY, maxEvents: 250_000 };
const WRITE_DEBOUNCE_MS = 2000;
const REPLY_DEBOUNCE_MS = 1000;
const H5 = 5 * 3600_000;
/** Bump to force a one-time ledger reset (events/cursors kept) so the next reading re-baselines. */
const LEDGER_REV = 2;

export type UsageSource = "desktop" | "claude-code";

export function parseSources(v: string | undefined): UsageSource[] | null {
  if (!v) return null;
  const out = v.split(",").map((x) => x.trim().toLowerCase()).filter((x): x is UsageSource => x === "desktop" || x === "claude-code");
  return out.length ? out : null;
}

export function createEngine(opts: { dataDir: string; projectsDir: string; scanIntervalMs?: number; sources?: UsageSource[]; now?: () => number }): Engine {
  const now = opts.now ?? Date.now;
  const interval = opts.scanIntervalMs ?? 5000;
  const file = join(opts.dataDir, "engine-state.json");
  const sources = new Set<string>(opts.sources ?? parseSources(process.env.USAGE_METER_SOURCES) ?? (["desktop"] as UsageSource[]));

  let cursors: Cursors = {};
  let events: UsageEvent[] = [];
  let ledger: Ledger = emptyLedger();
  let backfillDone = false;
  let lastScanAt: number | null = null;
  let filesRead = 0;
  let scanError: string | undefined;

  const changeCbs = new Set<() => void>();
  const replyCbs = new Set<() => void>();
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let scanning: Promise<void> | null = null;
  let dirty = false;
  let writeChain: Promise<void> = Promise.resolve();

  function fire(set: Set<() => void>): void {
    for (const cb of [...set]) {
      try {
        cb();
      } catch (e: any) {
        console.warn(`[engine] listener failed: ${e?.message ?? e}`);
      }
    }
  }

  function load(): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") console.warn(`[engine] cannot read state: ${e?.code ?? e?.message}`);
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!raw || raw.v !== 1 || !Array.isArray(raw.events) || !raw.cursors || typeof raw.cursors !== "object") throw new Error("bad shape");
      cursors = raw.cursors;
      events = raw.events.filter((e: any) => e && typeof e.id === "string" && Number.isFinite(e.ts));
      ledger = raw.ledgerRev === LEDGER_REV ? normalizeLedger(raw.ledger) : emptyLedger();
      if (raw.ledgerRev !== LEDGER_REV) dirty = true;
      backfillDone = true;
    } catch (e: any) {
      console.warn(`[engine] corrupt state, starting fresh (${e?.message ?? e})`);
      try {
        renameSync(file, file + ".bak");
      } catch {
        /* ignore */
      }
      cursors = {};
      events = [];
      ledger = emptyLedger();
      backfillDone = false;
    }
  }

  function serialize(): string {
    const p: Persisted = { v: 1, cursors, events, ledger, ledgerRev: LEDGER_REV };
    return JSON.stringify(p);
  }

  async function writeAsync(): Promise<void> {
    const data = serialize();
    const tmp = file + ".tmp";
    await mkdir(opts.dataDir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  function flushNow(): void {
    // Synchronous final write (used on stop()).
    try {
      mkdirSync(opts.dataDir, { recursive: true });
      const tmp = file + ".tmp";
      writeFileSync(tmp, serialize());
      renameSync(tmp, file);
      dirty = false;
    } catch (e: any) {
      console.warn(`[engine] cannot write state: ${e?.code ?? e?.message}`);
    }
  }

  function schedulePersist(): void {
    dirty = true;
    if (writeTimer || !running) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      if (!dirty) return;
      dirty = false;
      writeChain = writeChain
        .then(writeAsync)
        .catch((e: any) => {
          dirty = true;
          console.warn(`[engine] cannot write state: ${e?.code ?? e?.message}`);
        });
    }, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  }

  function scheduleReplies(): void {
    if (replyTimer) return;
    replyTimer = setTimeout(() => {
      replyTimer = null;
      fire(replyCbs);
    }, REPLY_DEBOUNCE_MS);
    replyTimer.unref?.();
  }

  // Cache reads barely count against plan limits: discount them for the attribution weight only.
  function promptForWeight(e: UsageEvent): number {
    return Math.max(0, e.promptTokens - 0.9 * (e.cacheReadTokens ?? 0));
  }

  async function doScan(): Promise<void> {
    const t = now();
    try {
      const r = await scan({ projectsDir: opts.projectsDir, cursors, deviceId: "local", since: t - 7 * DAY });
      const known = new Set(events.map((e) => e.id));
      const fresh = r.events.filter((e) => !known.has(e.id));
      cursors = r.cursors;
      events = pruneEvents(mergeEvents(events, r.events), t, LIMITS);
      filesRead = r.filesRead;
      scanError = undefined;
      lastScanAt = t;
      let added = 0;
      if (backfillDone) {
        for (const e of fresh) {
          if (!sources.has(e.source)) continue;
          if (e.ts < t - H5) continue; // stale lines (old file resumed) cannot explain a new reading
          ledger = addContribution(ledger, { model: e.model, weight: replyWeight(e.model, promptForWeight(e), e.outputTokens), ts: e.ts, source: "local" });
          added++;
        }
      }
      backfillDone = true;
      schedulePersist();
      fire(changeCbs);
      if (added > 0) scheduleReplies();
    } catch (e: any) {
      scanError = String(e?.code ?? e?.message ?? e).slice(0, 120);
      lastScanAt = t;
      console.warn(`[engine] scan failed: ${scanError}`);
      fire(changeCbs);
    }
  }

  function runScan(): Promise<void> {
    if (!scanning) scanning = doScan().finally(() => (scanning = null));
    return scanning;
  }

  function loop(): void {
    if (!running) return;
    void runScan().finally(() => {
      if (!running) return;
      scanTimer = setTimeout(loop, interval);
      scanTimer.unref?.();
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      load();
      loop();
    },
    stop() {
      if (!running) return;
      running = false;
      for (const t of [scanTimer, writeTimer, replyTimer]) if (t) clearTimeout(t);
      scanTimer = writeTimer = replyTimer = null;
      flushNow();
    },
    applyAccountUsage(u, at) {
      try {
        ledger = applyReading(ledger, u, at, {
          baseline: (_w, startMs) => {
            const out: Record<string, number> = {};
            for (const e of events) {
              if (!sources.has(e.source) || e.ts < startMs || e.ts > at) continue;
              out[e.model] = (out[e.model] ?? 0) + replyWeight(e.model, promptForWeight(e), e.outputTokens);
            }
            return out;
          },
        });
        schedulePersist();
        fire(changeCbs);
      } catch (e: any) {
        console.warn(`[engine] applyAccountUsage failed: ${e?.message ?? e}`);
      }
    },
    resetAttribution() {
      ledger = emptyLedger();
      schedulePersist();
      fire(changeCbs);
    },
    refreshNow() {
      return runScan();
    },
    snapshot() {
      const t = now();
      const local: DesktopState["local"] = [];
      const tokens5hByModel: Record<string, number> = {};
      const srcEvents = events.filter((e) => sources.has(e.source));
      for (const source of ["claude-code", "desktop"] as const) {
        if (!sources.has(source)) continue;
        const evs = srcEvents.filter((e) => e.source === source);
        if (!evs.length) continue;
        const aggregates = computeAggregates(evs, t);
        local.push({ source, aggregates });
        for (const [m, v] of Object.entries(aggregates.last5h.byModel)) tokens5hByModel[m] = (tokens5hByModel[m] ?? 0) + v.tokens;
      }
      // NEW tokens: prompt minus cache reads, plus output (cache reads barely count against limits).
      const tokensNew5hByModel: Record<string, number> = {};
      for (const e of srcEvents) {
        if (e.ts < t - H5 || e.ts > t) continue;
        const n = Math.max(0, e.promptTokens - (e.cacheReadTokens ?? 0)) + e.outputTokens;
        tokensNew5hByModel[e.model] = (tokensNew5hByModel[e.model] ?? 0) + n;
      }
      const scanState: DesktopState["scan"] = { lastScanAt, filesRead };
      if (scanError) scanState.error = scanError;
      return { attribution: attributionView(ledger), local, tokens5hByModel, tokensNew5hByModel, scan: scanState };
    },
    onChange(cb) {
      changeCbs.add(cb);
      return () => void changeCbs.delete(cb);
    },
    onReplies(cb) {
      replyCbs.add(cb);
      return () => void replyCbs.delete(cb);
    },
  };
}
