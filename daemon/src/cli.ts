import { computeAggregates } from "../../src/shared/aggregate";
import type { Aggregates, WindowAggregate } from "../../src/shared/types";
import { buildReport, normalizeBase, ping, sendReport } from "../../src/sync/deskbuddy";
import { configPath, loadConfig, saveConfig, statePath } from "./config";
import type { DaemonConfig, DaemonState } from "./contracts";
import { scan } from "./scanner";
import { loadState, saveState } from "./state";
import { mergeEvents } from "./transcript";

const HELP = `deskbuddy-cc - report Claude Code token usage to a DeskBuddy device

Usage: deskbuddy-cc [command] [options]
  run                 Watch transcripts and sync continuously (default)
  once [--dry-run]    Scan once, print totals, sync (or print the report with --dry-run)
  status              Show config, last sync and totals
  config [--url U] [--name N] [--token T] [--projects-dir D]
                      Save settings and print them
  ping                Check the DeskBuddy device is reachable
  --help              This text

Env: DESKBUDDY_URL, DESKBUDDY_TOKEN override the config file; CLAUDE_CONFIG_DIR sets the projects dir.`;

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (m: string) => console.log(`[${ts()}] ${m}`);
const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const shortModel = (m: string) => m.replace(/^claude-/, "");

function mask(t: string): string {
  return t ? (t.length <= 4 ? "****" : t.slice(0, 2) + "****" + t.slice(-2)) : "(none)";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

function printWindow(name: string, w: WindowAggregate): void {
  console.log(`${name.padEnd(6)} messages=${w.messages}  prompt=${fmt(w.promptTokens)}  output=${fmt(w.outputTokens)}`);
  for (const [m, v] of Object.entries(w.byModel).sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`         ${shortModel(m).padEnd(24)} ${String(v.messages).padStart(5)} msgs  ${fmt(v.tokens).padStart(8)} tok`);
  }
}

function printAggregates(a: Aggregates): void {
  printWindow("today", a.today);
  printWindow("5h", a.last5h);
  printWindow("7d", a.last7d);
}

async function scanInto(cfg: DaemonConfig, state: DaemonState, now = Date.now()): Promise<{ added: number; tokens: number }> {
  const res = await scan({
    projectsDir: cfg.projectsDir,
    cursors: state.cursors,
    deviceId: cfg.deviceId,
    since: now - cfg.backfillDays * 86400e3,
  });
  const before = state.events.length;
  const beforeTokens = state.events.reduce((s, e) => s + e.promptTokens + e.outputTokens, 0);
  const merged = mergeEvents(state.events, res.events);
  const cursorsChanged = JSON.stringify(res.cursors) !== JSON.stringify(state.cursors);
  const afterTokens = merged.reduce((s, e) => s + e.promptTokens + e.outputTokens, 0);
  const changed = merged.length !== before || afterTokens !== beforeTokens;
  state.events = merged;
  state.cursors = res.cursors;
  if (changed || cursorsChanged) await saveState(state);
  return { added: Math.max(0, merged.length - before), tokens: Math.max(0, afterTokens - beforeTokens) };
}

async function sync(cfg: DaemonConfig, state: DaemonState): Promise<boolean> {
  if (!cfg.deskbuddyUrl) return false;
  const now = Date.now();
  const report = buildReport({ deviceId: cfg.deviceId, deviceName: cfg.deviceName }, state.events, null, now, {
    source: "claude-code",
    estimated: false,
  });
  state.lastSync.attemptAt = now;
  const r = await sendReport(cfg.deskbuddyUrl, cfg.sharedToken, report);
  if (r.ok) {
    state.lastSync.okAt = Date.now();
    state.lastSync.error = null;
  } else {
    state.lastSync.error = r.error ?? "unknown error";
  }
  await saveState(state);
  return r.ok;
}

async function cmdRun(): Promise<void> {
  const cfg = await loadConfig();
  const state = await loadState();
  log(`watching ${cfg.projectsDir} (every ${cfg.scanIntervalSec}s) as "${cfg.deviceName}"`);
  if (!cfg.deskbuddyUrl) log("no DeskBuddy URL set - scanning only (run: deskbuddy-cc config --url http://deskbuddy.local)");

  let stopping = false;
  let debounce: NodeJS.Timeout | undefined;
  let syncing = false;
  let lastHeartbeat = 0;

  const doSync = async (label: string): Promise<void> => {
    if (!cfg.deskbuddyUrl || syncing) return;
    syncing = true;
    try {
      const ok = await sync(cfg, state);
      lastHeartbeat = Date.now();
      log(ok ? `${label} -> synced` : `${label} -> sync failed: ${state.lastSync.error}`);
    } finally {
      syncing = false;
    }
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (debounce) clearTimeout(debounce);
    try {
      await saveState(state);
    } finally {
      log("stopped");
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopping) {
    try {
      const { added, tokens } = await scanInto(cfg, state);
      if (added > 0) {
        const label = `+${added} ${added === 1 ? "reply" : "replies"} (${fmt(tokens)} tok)`;
        if (cfg.deskbuddyUrl) {
          log(label);
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void doSync(label), 3000);
        } else {
          log(label);
        }
      } else if (cfg.deskbuddyUrl && Date.now() - lastHeartbeat >= cfg.heartbeatSec * 1000) {
        await doSync("heartbeat");
      }
    } catch (e) {
      log(`scan error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, cfg.scanIntervalSec * 1000));
  }
}

async function cmdOnce(args: string[]): Promise<void> {
  const dry = args.includes("--dry-run");
  const cfg = await loadConfig();
  const state = await loadState();
  const { added } = await scanInto(cfg, state);
  console.log(`Scanned ${cfg.projectsDir}: ${added} new replies, ${state.events.length} stored`);
  printAggregates(computeAggregates(state.events, Date.now()));
  if (dry) {
    const report = buildReport({ deviceId: cfg.deviceId, deviceName: cfg.deviceName }, state.events, null, Date.now(), {
      source: "claude-code",
      estimated: false,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!cfg.deskbuddyUrl) {
    console.log("No DeskBuddy URL set - not syncing.");
    return;
  }
  const ok = await sync(cfg, state);
  console.log(ok ? "Synced." : `Sync failed: ${state.lastSync.error}`);
  if (!ok) process.exitCode = 1;
}

async function cmdStatus(): Promise<void> {
  const cfg = await loadConfig();
  const state = await loadState();
  console.log(`Config:       ${configPath()}`);
  console.log(`State:        ${statePath()}`);
  console.log(`Device:       ${cfg.deviceName} (${cfg.deviceId})`);
  console.log(`DeskBuddy:    ${cfg.deskbuddyUrl ? normalizeBase(cfg.deskbuddyUrl) : "(not set)"}`);
  console.log(`Token:        ${mask(cfg.sharedToken)}`);
  console.log(`Projects dir: ${cfg.projectsDir}`);
  console.log(`Intervals:    scan ${cfg.scanIntervalSec}s, heartbeat ${cfg.heartbeatSec}s, backfill ${cfg.backfillDays}d`);
  const l = state.lastSync;
  console.log(`Last sync:    ${l.okAt ? new Date(l.okAt).toLocaleString() : "never"}${l.error ? ` (last error: ${l.error})` : ""}`);
  console.log(`Events:       ${state.events.length} stored, ${Object.keys(state.cursors).length} files tracked`);
  printAggregates(computeAggregates(state.events, Date.now()));
}

async function cmdConfig(args: string[]): Promise<void> {
  const partial: Partial<DaemonConfig> = {};
  const url = flag(args, "--url");
  const name = flag(args, "--name");
  const token = flag(args, "--token");
  const dir = flag(args, "--projects-dir");
  if (url !== undefined) partial.deskbuddyUrl = url;
  if (name !== undefined) partial.deviceName = name;
  if (token !== undefined) partial.sharedToken = token;
  if (dir !== undefined) partial.projectsDir = dir;
  await loadConfig(); // ensure first-run defaults exist
  const cfg = await saveConfig(partial);
  console.log(JSON.stringify({ ...cfg, sharedToken: mask(cfg.sharedToken) }, null, 2));
  console.log(`Saved to ${configPath()}`);
}

async function cmdPing(): Promise<void> {
  const cfg = await loadConfig();
  const r = await ping(cfg.deskbuddyUrl, cfg.sharedToken);
  if (r.ok) console.log(`OK: ${normalizeBase(cfg.deskbuddyUrl)} reachable`);
  else {
    console.error(`Ping failed: ${r.error}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [cmd = "run", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return cmdRun();
    case "once":
      return cmdOnce(rest);
    case "status":
      return cmdStatus();
    case "config":
      return cmdConfig(rest);
    case "ping":
      return cmdPing();
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
