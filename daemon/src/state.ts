import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pruneEvents, type PruneLimits } from "../../src/shared/aggregate";
import { statePath } from "./config";
import type { DaemonState } from "./contracts";

// Only last7d is reported, so keep 8 days; heavy Claude Code use exceeds the extension's 20k cap.
export const DAEMON_PRUNE: PruneLimits = { retentionMs: 8 * 24 * 3600_000, maxEvents: 250_000 };

/** Bump when stored events must be re-derived from transcripts. 2 = per-client source tagging. */
export const STATE_REV = 2;

export function freshState(): DaemonState {
  return { v: 1, rev: STATE_REV, cursors: {}, events: [], lastSync: { okAt: null, attemptAt: null, error: null } };
}

export async function loadState(dir?: string): Promise<DaemonState> {
  const file = statePath(dir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return freshState();
  }
  try {
    const s = JSON.parse(text) as Partial<DaemonState>;
    if (s && s.v === 1 && s.cursors && typeof s.cursors === "object" && Array.isArray(s.events)) {
      // Older state tagged every event "claude-code"; drop cursors+events once so transcripts are re-read and re-tagged.
      if ((s.rev ?? 0) < STATE_REV) return { ...freshState(), lastSync: s.lastSync ?? freshState().lastSync };
      return { ...freshState(), ...s, v: 1 } as DaemonState;
    }
    throw new Error("bad shape");
  } catch {
    try {
      await rename(file, file + ".bak");
    } catch {
      /* ignore */
    }
    return freshState();
  }
}

export async function saveState(s: DaemonState, dir?: string, now = Date.now()): Promise<void> {
  s.events = pruneEvents(s.events, now, DAEMON_PRUNE);
  const file = statePath(dir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s));
  await rename(tmp, file);
}
