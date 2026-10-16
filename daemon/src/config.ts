import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./contracts";

/**
 * Home dir: $CLAUDE_USAGE_HUB_HOME, else legacy $DESKBUDDY_HOME, else ~/.claude-usage-hub.
 * An existing legacy ~/.deskbuddy is kept in use when the new dir does not exist yet.
 */
export function defaultDir(): string {
  const env = process.env.CLAUDE_USAGE_HUB_HOME || process.env.DESKBUDDY_HOME;
  if (env) return env;
  const next = join(homedir(), ".claude-usage-hub");
  const legacy = join(homedir(), ".deskbuddy");
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
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
    desktopDeviceName: `${hostname()}-Desktop`,
    hubUrl: "",
    hubToken: "",
    projectsDir: defaultProjectsDir(),
    scanIntervalSec: 10,
    heartbeatSec: 60,
    backfillDays: 7,
  };
}

const STRINGS = ["deviceId", "deviceName", "desktopDeviceName", "hubUrl", "hubToken", "projectsDir"] as const;
/** Pre-pivot config keys, read when the new key is absent. */
const LEGACY_KEYS = { deskbuddyUrl: "hubUrl", sharedToken: "hubToken" } as const;
const NUMBERS = ["scanIntervalSec", "heartbeatSec", "backfillDays"] as const;

function merge(defaults: DaemonConfig, raw: unknown, warn: (m: string) => void): DaemonConfig {
  const out = { ...defaults } as Record<string, string | number>;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = { ...(raw as Record<string, unknown>) };
    for (const [old, now] of Object.entries(LEGACY_KEYS)) {
      if (old in r && !(now in r)) r[now] = old === "deskbuddyUrl" && r[old] === "http://deskbuddy.local" ? "" : r[old];
      delete r[old];
    }
    for (const k of STRINGS) {
      if (!(k in r)) continue;
      if (typeof r[k] === "string" && (r[k] !== "" || k === "hubUrl" || k === "hubToken")) out[k] = r[k] as string;
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
  const legacy = !!raw && typeof raw === "object" && Object.keys(LEGACY_KEYS).some((k) => k in (raw as object));
  if (!existed || legacy) await writeFile(file, JSON.stringify(cfg, null, 2) + "\n"); // legacy keys are migrated once
  const envUrl = process.env.CLAUDE_USAGE_HUB_URL || process.env.DESKBUDDY_URL;
  const envToken = process.env.CLAUDE_USAGE_HUB_TOKEN || process.env.DESKBUDDY_TOKEN;
  if (envUrl) cfg.hubUrl = envUrl;
  if (envToken) cfg.hubToken = envToken;
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
