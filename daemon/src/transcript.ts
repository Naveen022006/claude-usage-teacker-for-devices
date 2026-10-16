// Pure parsing/merging of Claude Code transcript lines. Never keeps message content.
import type { UsageEvent } from "../../src/shared/types";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function parseTranscriptLine(line: string, deviceId: string): UsageEvent | null {
  if (!line || !line.includes('"assistant"')) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.type !== "assistant") return null;
  const msg = obj.message;
  if (!msg || typeof msg !== "object") return null;
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") return null;
  if (typeof msg.id !== "string" || !msg.id) return null;
  const model = msg.model;
  if (typeof model !== "string" || !model || model === "<synthetic>") return null;
  const ts = typeof obj.timestamp === "string" || typeof obj.timestamp === "number" ? Date.parse(String(obj.timestamp)) : NaN;
  if (!Number.isFinite(ts)) return null;

  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  // `entrypoint` on every line: "cli" | "claude-vscode" | "claude-desktop". Desktop gets its own source/device.
  const desktop = obj.entrypoint === "claude-desktop";
  return {
    id: msg.id,
    ts,
    source: desktop ? "desktop" : "claude-code",
    deviceId: desktop ? `${deviceId}-desktop` : deviceId,
    model,
    promptChars: 0,
    outputChars: 0,
    thinkingChars: 0,
    promptTokens: num(usage.input_tokens) + cacheCreate + cacheRead,
    outputTokens: num(usage.output_tokens),
    estimated: false,
    status: obj.isApiErrorMessage === true ? "error" : "ok",
    kind: "new",
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
  };
}

export function mergeEvents(existing: UsageEvent[], incoming: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const list of [existing, incoming]) {
    for (const e of list) {
      const cur = map.get(e.id);
      if (!cur) {
        map.set(e.id, e);
        continue;
      }
      const ts = Math.min(cur.ts, e.ts);
      const best = e.promptTokens + e.outputTokens > cur.promptTokens + cur.outputTokens ? e : cur;
      map.set(e.id, best.ts === ts ? best : { ...best, ts });
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
