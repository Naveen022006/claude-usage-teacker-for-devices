import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./contracts";

export function defaultDir(): string {
  return join(homedir(), ".deskbuddy");
}
export const configPath = (dir = defaultDir()) => join(dir, "claude-code.json");
export const statePath = (dir = defaultDir()) => join(dir, "claude-code-state.json");

function defaultProjectsDir(): string {
  const c = process.env.CLAUDE_CONFIG_DIR;
  return c ? join(c, "projects") : join(homedir(), ".claude", "projects");
}

export function defaultConfig(): DaemonConfig {
  return {
    deviceId: randomUUID(),
    deviceName: `${hostname()}-ClaudeCode`,
    deskbuddyUrl: "",
    sharedToken: "",
    projectsDir: defaultProjectsDir(),
    scanIntervalSec: 10,
    heartbeatSec: 60,
    backfillDays: 7,
  };
}

const STRINGS = ["deviceId", "deviceName", "deskbuddyUrl", "sharedToken", "projectsDir"] as const;
const NUMBERS = ["scanIntervalSec", "heartbeatSec", "backfillDays"] as const;

function merge(defaults: DaemonConfig, raw: unknown, warn: (m: string) => void): DaemonConfig {
  const out = { ...defaults } as Record<string, string | number>;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    for (const k of STRINGS) {
      if (!(k in r)) continue;
      if (typeof r[k] === "string" && (r[k] !== "" || k === "deskbuddyUrl" || k === "sharedToken")) out[k] = r[k] as string;
      else warn(`config: "${k}" must be a string; using default`);
    }
    for (const k of NUMBERS) {
      if (!(k in r)) continue;
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
      else warn(`config: "${k}" must be a positive number; using default`);
    }
  } else if (raw !== undefined) {
    warn("config: file is not a JSON object; using defaults");
  }
  return out as unknown as DaemonConfig;
}

export async function loadConfig(dir = defaultDir(), warn: (m: string) => void = (m) => console.warn(m)): Promise<DaemonConfig> {
  await mkdir(dir, { recursive: true });
  const file = configPath(dir);
  let raw: unknown;
  let existed = true;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") existed = false;
    else warn("config: unreadable file; using defaults");
  }
  const cfg = merge(defaultConfig(), raw, warn);
  if (!existed) await writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
  if (process.env.DESKBUDDY_URL) cfg.deskbuddyUrl = process.env.DESKBUDDY_URL;
  if (process.env.DESKBUDDY_TOKEN) cfg.sharedToken = process.env.DESKBUDDY_TOKEN;
  return cfg;
}

/** Persist a partial update to the file (env overrides are never written). */
export async function saveConfig(partial: Partial<DaemonConfig>, dir = defaultDir()): Promise<DaemonConfig> {
  await mkdir(dir, { recursive: true });
  let current: unknown;
  try {
    current = JSON.parse(await readFile(configPath(dir), "utf8"));
  } catch {
    /* missing or corrupt: start from defaults */
  }
  const cfg = merge(defaultConfig(), current, () => {});
  Object.assign(cfg, partial);
  await writeFile(configPath(dir), JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}
