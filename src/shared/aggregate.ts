import type { Aggregates, UsageEvent, WindowAggregate } from "./types";

export const RETENTION_MS = 30 * 24 * 3600_000;
export const MAX_EVENTS = 20000;
const H5 = 5 * 3600_000;
const D7 = 7 * 24 * 3600_000;

function empty(): WindowAggregate {
  return { messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} };
}

/**
 * Every event counts as a message regardless of status: error/aborted replies
 * still consumed usage on the account. Windows include their start (ts >= start)
 * and exclude future events (ts > now).
 * "today" starts at local midnight of `now` (runtime timezone).
 */
export function computeAggregates(events: UsageEvent[], now: number): Aggregates {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const starts = { today: d.getTime(), last5h: now - H5, last7d: now - D7 };
  const out: Aggregates = { today: empty(), last5h: empty(), last7d: empty() };
  for (const e of events) {
    if (e.ts > now) continue;
    for (const name of ["today", "last5h", "last7d"] as const) {
      if (e.ts < starts[name]) continue;
      const w = out[name];
      w.messages++;
      w.promptTokens += e.promptTokens;
      w.outputTokens += e.outputTokens;
      const m = (w.byModel[e.model] ??= { messages: 0, tokens: 0 });
      m.messages++;
      m.tokens += e.promptTokens + e.outputTokens;
    }
  }
  return out;
}

/** Keep the last 30 days, at most MAX_EVENTS (newest kept). Output sorted oldest-first only when capped. */
export function pruneEvents(events: UsageEvent[], now: number): UsageEvent[] {
  const cutoff = now - RETENTION_MS;
  let kept = events.filter((e) => e.ts >= cutoff);
  if (kept.length > MAX_EVENTS) {
    kept = [...kept].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS).sort((a, b) => a.ts - b.ts);
  }
  return kept;
}
