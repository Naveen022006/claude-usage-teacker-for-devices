import { computeAggregates } from "../../src/shared/aggregate";
import type { Aggregates, Report, Source, UsageEvent, WindowAggregate } from "../../src/shared/types";
import { buildReport, normalizeBase, ping, sendReport } from "../../src/sync/hub";
import { configPath, loadConfig, saveConfig, statePath } from "./config";
import type { DaemonConfig, DaemonState } from "./contracts";
import { scan } from "./scanner";
import { loadState, saveState } from "./state";
import { mergeEvents } from "./transcript";

const HELP = `claude-usage-daemon - report Claude Code token usage to your Usage Hub

Usage: claude-usage-daemon [command] [options]
  run                 Watch transcripts and sync continuously (default)
  once [--dry-run]    Scan once, print totals, sync (or print the report with --dry-run)
  status              Show config, last sync and totals
  config [--url U] [--name N] [--desktop-name N] [--token T] [--projects-dir D]
                      Save settings and print them
  ping                Check the hub is reachable (GET /api/ping)
  --help              This text

Env: CLAUDE_USAGE_HUB_URL, CLAUDE_USAGE_HUB_TOKEN override the config file (legacy DESKBUDDY_URL / DESKBUDDY_TOKEN still work);
CLAUDE_USAGE_HUB_HOME moves the ~/.claude-usage-hub dir (legacy DESKBUDDY_HOME, and an existing ~/.deskbuddy, are still honoured);
CLAUDE_CONFIG_DIR sets the projects dir.`;

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

const SOURCES: { source: Source; label: string }[] = [
  { source: "claude-code", label: "Claude Code (cli / VS Code)" },
  { source: "desktop", label: "Claude Desktop (Code sessions)" },
];

/** One report per source that has events in the last 7 days. */
function buildReports(cfg: DaemonConfig, events: UsageEvent[], now: number): Report[] {
  const out: Report[] = [];
  for (const { source } of SOURCES) {
    const evs = events.filter((e) => e.source === source);
    if (!evs.some((e) => e.ts >= now - 7 * 86400e3)) continue;
    const device =
      source === "desktop"
        ? { deviceId: `${cfg.deviceId}-desktop`, deviceName: cfg.desktopDeviceName }
        : { deviceId: cfg.deviceId, deviceName: cfg.deviceName };
    out.push(buildReport(device, evs, null, now, { source, estimated: false }));
  }
  return out;
}

function printPerSource(events: UsageEvent[], now: number): void {
  for (const { source, label } of SOURCES) {
    const evs = events.filter((e) => e.source === source);
    console.log(`
[${label}] ${evs.length} events`);
    if (evs.length) printAggregates(computeAggregates(evs, now));
  }
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
  if (!cfg.hubUrl) return false;
  const now = Date.now();
  state.lastSync.attemptAt = now;
  let error: string | null = null;
  for (const report of buildReports(cfg, state.events, now)) {
    const r = await sendReport(cfg.hubUrl, cfg.hubToken, report);
    if (!r.ok && error === null) error = `${report.source}: ${r.error ?? "unknown error"}`;
  }
  if (error === null) state.lastSync.okAt = Date.now();
  state.lastSync.error = error;
  await saveState(state);
  return error === null;
}

async function cmdRun(): Promise<void> {
  const cfg = await loadConfig();
  const state = await loadState();
  log(`watching ${cfg.projectsDir} (every ${cfg.scanIntervalSec}s) as "${cfg.deviceName}" / "${cfg.desktopDeviceName}"`);
  if (!cfg.hubUrl) log("no hub URL set - scanning only (run: claude-usage-daemon config --url https://your-hub.vercel.app --token SECRET)");

  let stopping = false;
  let debounce: NodeJS.Timeout | undefined;
  let syncing = false;
  let lastHeartbeat = 0;

  const doSync = async (label: string): Promise<void> => {
    if (!cfg.hubUrl || syncing) return;
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
        if (cfg.hubUrl) {
          log(label);
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void doSync(label), 3000);
        } else {
          log(label);
        }
      } else if (cfg.hubUrl && Date.now() - lastHeartbeat >= cfg.heartbeatSec * 1000) {
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
  printPerSource(state.events, Date.now());
  if (dry) {
    for (const report of buildReports(cfg, state.events, Date.now())) console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!cfg.hubUrl) {
    console.log("No hub URL set - not syncing.");
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
  console.log(`Desktop:      ${cfg.desktopDeviceName} (${cfg.deviceId}-desktop)`);
  console.log(`Hub:          ${cfg.hubUrl ? normalizeBase(cfg.hubUrl) : "(not set)"}`);
  console.log(`Token:        ${mask(cfg.hubToken)}`);
  console.log(`Projects dir: ${cfg.projectsDir}`);
  console.log(`Intervals:    scan ${cfg.scanIntervalSec}s, heartbeat ${cfg.heartbeatSec}s, backfill ${cfg.backfillDays}d`);
  const l = state.lastSync;
  console.log(`Last sync:    ${l.okAt ? new Date(l.okAt).toLocaleString() : "never"}${l.error ? ` (last error: ${l.error})` : ""}`);
  console.log(`Events:       ${state.events.length} stored, ${Object.keys(state.cursors).length} files tracked`);
  printPerSource(state.events, Date.now());
}

async function cmdConfig(args: string[]): Promise<void> {
  const partial: Partial<DaemonConfig> = {};
  const url = flag(args, "--url");
  const name = flag(args, "--name");
  const desktopName = flag(args, "--desktop-name");
  const token = flag(args, "--token");
  const dir = flag(args, "--projects-dir");
  if (url !== undefined) partial.hubUrl = url;
  if (name !== undefined) partial.deviceName = name;
  if (desktopName !== undefined) partial.desktopDeviceName = desktopName;
  if (token !== undefined) partial.hubToken = token;
  if (dir !== undefined) partial.projectsDir = dir;
  await loadConfig(); // ensure first-run defaults exist
  const cfg = await saveConfig(partial);
  console.log(JSON.stringify({ ...cfg, hubToken: mask(cfg.hubToken) }, null, 2));
  console.log(`Saved to ${configPath()}`);
}

async function cmdPing(): Promise<void> {
  const cfg = await loadConfig();
  const r = await ping(cfg.hubUrl, cfg.hubToken);
  if (r.ok) console.log(`OK: ${normalizeBase(cfg.hubUrl)} reachable`);
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
