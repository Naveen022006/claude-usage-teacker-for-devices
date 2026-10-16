// Claude Code statusLine command (documented: https://code.claude.com/docs/en/statusline).
// Claude Code pipes a JSON object to stdin; for Pro/Max subscribers it includes
// rate_limits.{five_hour,seven_day}.{used_percentage (0-100), resets_at (epoch s)} for the signed-in account.
//
// The user's Claude Code CLI and Claude Desktop are signed in to DIFFERENT accounts, and only Claude Desktop
// matters. So: sessions started by Claude Desktop (entrypoint "claude-desktop") record their limits to
// %APPDATA%/UsageMeterDesktop/desktop-limits.json for the tray app; every other session is ignored and prints
// nothing, leaving the CLI unchanged. Only numbers are written — never prompts, paths or credentials.
// Must be fast and must never fail loudly: any problem → print nothing, exit 0.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LimitWindow {
  used_percentage?: unknown;
  resets_at?: unknown;
}
interface StatusInput {
  session_id?: unknown;
  transcript_path?: unknown;
  model?: { id?: unknown };
  rate_limits?: { five_hour?: LimitWindow; seven_day?: LimitWindow };
}

export interface DesktopLimits {
  v: 1;
  fetchedAt: number; // epoch ms when Claude Code (Desktop) last reported limits
  windows: { name: "five_hour" | "seven_day"; utilization: number; resetsAt?: string }[];
  model?: string;
}

const DESKTOP = "claude-desktop";

export function dataDir(env = process.env): string {
  const base = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(base, "UsageMeterDesktop");
}

/** Reads the last ~64 KB of the transcript and returns the most recent `"entrypoint":"…"` value. */
export function entrypointFromTranscript(path: string): string | null {
  let fd: number | null = null;
  try {
    if (!existsSync(path)) return null;
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = [...buf.toString("utf8").matchAll(/"entrypoint":"([a-z-]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Desktop if Claude Code says so via env, else via the session's transcript. */
export function isDesktopSession(input: StatusInput, env = process.env): boolean {
  const e = env.CLAUDE_CODE_ENTRYPOINT;
  if (e) return e === DESKTOP;
  return typeof input.transcript_path === "string" && entrypointFromTranscript(input.transcript_path) === DESKTOP;
}

function pct(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

function iso(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n).toISOString(); // documented as epoch seconds
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

export function toLimits(input: StatusInput, now: number): DesktopLimits | null {
  const rl = input.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const windows: DesktopLimits["windows"] = [];
  for (const name of ["five_hour", "seven_day"] as const) {
    const w = rl[name];
    const u = pct(w?.used_percentage);
    if (u === null) continue;
    windows.push({ name, utilization: u, resetsAt: iso(w?.resets_at) });
  }
  if (!windows.length) return null;
  const model = typeof input.model?.id === "string" ? input.model.id.slice(0, 100) : undefined;
  return { v: 1, fetchedAt: now, windows, model };
}

export function writeLimits(dir: string, limits: DesktopLimits): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "desktop-limits.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(limits));
  renameSync(tmp, file);
}

/** One short line for Desktop sessions; "" for everything else. */
export function statusText(l: DesktopLimits | null): string {
  if (!l) return "";
  const f = l.windows.find((w) => w.name === "five_hour");
  const s = l.windows.find((w) => w.name === "seven_day");
  return [f && `Session ${Math.round(f.utilization)}%`, s && `Weekly ${Math.round(s.utilization)}%`].filter(Boolean).join(" · ");
}

export function run(raw: string, env = process.env, now = Date.now()): string {
  let input: StatusInput;
  try {
    input = JSON.parse(raw) as StatusInput;
  } catch {
    return "";
  }
  if (!input || typeof input !== "object" || !isDesktopSession(input, env)) return "";
  const limits = toLimits(input, now);
  if (limits) {
    try {
      writeLimits(dataDir(env), limits);
    } catch {
      /* never break the status line */
    }
  }
  return statusText(limits);
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(run(raw));
    } catch {
      /* print nothing */
    }
    process.exit(0);
  });
}
