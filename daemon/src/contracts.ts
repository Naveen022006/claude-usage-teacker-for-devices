// Phase 2 — Claude Code usage daemon. Contracts shared by the scanner (transcript.ts,
// scanner.ts) and the daemon shell (config.ts, state.ts, cli.ts). See docs/09-claude-code-daemon.md.
//
// Verified transcript facts (Claude Code, 2026-10):
//  - Transcripts: <projectsDir>/<project>/<sessionId>.jsonl and, for subagents,
//    <projectsDir>/<project>/<sessionId>/subagents/agent-*.jsonl. Scan recursively.
//  - Lines with type === "assistant" carry message.{id, model, usage} and a top-level ISO `timestamp`.
//  - ONE API reply is written as SEVERAL lines (one per content block) that repeat the same
//    message.id and usage → dedupe by message.id or totals inflate ~2–3×.
//  - Resumed/forked sessions may copy earlier lines into a new file → dedupe across files too.
//  - usage: input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
//    output_tokens_details.thinking_tokens (thinking is already included in output_tokens).
//  - model "<synthetic>" marks locally generated messages with no API usage → skip.
// Never read or keep message content — only ids, model, timestamp and usage numbers.

import type { UsageEvent } from "../../src/shared/types";

/** Where we are in one transcript file. `offset` always sits just after a complete line. */
export interface FileCursor {
  offset: number;
  size: number;
  mtimeMs: number;
}

/** Keyed by absolute file path. */
export type Cursors = Record<string, FileCursor>;

export interface ScanOptions {
  projectsDir: string;
  cursors: Cursors;
  deviceId: string;
  /** Skip files whose mtime is older than this (epoch ms) when they have no cursor yet. */
  since: number;
}

export interface ScanResult {
  /** New/updated events from this scan, already deduped among themselves. */
  events: UsageEvent[];
  /** Full replacement cursor map (cursors for deleted files dropped). */
  cursors: Cursors;
  filesRead: number;
}

/** Persisted daemon state (~/.claude-usage-hub/claude-code-state.json). */
export interface DaemonState {
  v: 1;
  /** Migration revision. 2 = events are tagged by client (source "desktop" vs "claude-code"). Missing/older -> reset cursors+events once (rebackfill). */
  rev?: number;
  cursors: Cursors;
  events: UsageEvent[]; // last 30 days, unique by id
  lastSync: { okAt: number | null; attemptAt: number | null; error: string | null };
}

/** User config (~/.claude-usage-hub/claude-code.json). */
export interface DaemonConfig {
  deviceId: string;
  deviceName: string; // default `${hostname}-ClaudeCode`
  desktopDeviceName: string; // default `${hostname}-Desktop` (Claude Desktop Code sessions, deviceId `${deviceId}-desktop`)
  hubUrl: string; // "" = sync disabled
  hubToken: string;
  projectsDir: string; // default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects
  scanIntervalSec: number; // default 10
  heartbeatSec: number; // default 60
  backfillDays: number; // default 7
}

// Implemented in transcript.ts:
//   parseTranscriptLine(line: string, deviceId: string): UsageEvent | null
//   mergeEvents(existing: UsageEvent[], incoming: UsageEvent[]): UsageEvent[]
// Implemented in scanner.ts:
//   scan(opts: ScanOptions): Promise<ScanResult>
