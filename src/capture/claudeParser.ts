// Maps claude.ai completion SSE events to a CapturedEvent. Stores lengths only, never text.
// Undocumented API: every path is defensive and must never throw.

import type { CapturedEvent, EventKind, LimitHint } from "../shared/types";
import type { SseEvent } from "./sse";

export interface RequestMeta {
  kind: EventKind;
  requestModel?: string;
  promptChars: number;
  orgId?: string;
}

export const COMPLETION_RE = /\/api\/organizations\/([^/]+)\/chat_conversations\/[^/]+\/(retry_)?completion/;

export function isCompletionUrl(url: string): boolean {
  return typeof url === "string" && COMPLETION_RE.test(url);
}

/** Build request metadata from the URL and parsed/raw JSON body. Returns null if not a completion URL. */
export function parseRequestMeta(url: string, body: unknown): RequestMeta | null {
  try {
    const m = typeof url === "string" ? COMPLETION_RE.exec(url) : null;
    if (!m) return null;
    let b: unknown = body;
    if (typeof b === "string") {
      try {
        b = JSON.parse(b);
      } catch {
        b = null;
      }
    }
    const o = b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    const meta: RequestMeta = {
      kind: m[2] ? "retry" : "new",
      promptChars: typeof o.prompt === "string" ? o.prompt.length : 0,
      orgId: m[1],
    };
    if (typeof o.model === "string" && o.model) meta.requestModel = o.model;
    return meta;
  } catch {
    return null;
  }
}

export interface ClaudeStreamParser {
  onEvent(e: SseEvent): void;
  finish(outcome: "done" | "error" | "aborted"): CapturedEvent;
  /** True once a stream-level error event was seen. */
  readonly sawError: boolean;
}

const MAX_STR = 64;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function flatten(o: Record<string, unknown>): LimitHint["fields"] {
  const fields: LimitHint["fields"] = {};
  const put = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
    else if (typeof v === "boolean") fields[k] = v;
    else if (typeof v === "string" && v.length <= MAX_STR) fields[k] = v;
  };
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
    else put(k, v);
  }
  return fields;
}

export function createClaudeStreamParser(
  meta: RequestMeta,
  onLimitHint?: (hint: LimitHint) => void,
): ClaudeStreamParser {
  let model: string | undefined;
  let id: string | undefined;
  let outputChars = 0;
  let thinkingChars = 0;
  let errored = false;
  const blocks = new Map<number, string>();

  const handle = (e: SseEvent) => {
    let j: unknown;
    try {
      j = e.data ? JSON.parse(e.data) : {};
    } catch {
      console.warn("[claude-usage] bad JSON in SSE event", e.event);
      return;
    }
    if (!isObj(j)) return;
    const name = e.event !== "message" ? e.event : typeof j.type === "string" ? j.type : e.event;

    switch (name) {
      case "message_start": {
        const msg = isObj(j.message) ? j.message : {};
        if (typeof msg.model === "string" && msg.model) model = msg.model;
        if (typeof msg.id === "string" && msg.id) id = msg.id;
        return;
      }
      case "content_block_start": {
        const cb = isObj(j.content_block) ? j.content_block : {};
        if (typeof j.index === "number" && typeof cb.type === "string") blocks.set(j.index, cb.type);
        return;
      }
      case "content_block_delta": {
        const d = isObj(j.delta) ? j.delta : {};
        const bt = typeof j.index === "number" ? blocks.get(j.index) : undefined;
        if (typeof d.thinking === "string") {
          thinkingChars += d.thinking.length;
        } else if (typeof d.text === "string") {
          if (bt === "thinking" && d.type !== "text_delta") thinkingChars += d.text.length;
          else outputChars += d.text.length;
        }
        return;
      }
      case "content_block_stop":
      case "message_delta":
      case "message_stop":
      case "ping":
        return;
      case "error":
        errored = true;
        return;
      default:
        if (name.includes("limit")) {
          const fields = flatten(j);
          if (Object.keys(fields).length) onLimitHint?.({ ts: Date.now(), fields });
          return;
        }
        console.warn("[claude-usage] unknown SSE event", name);
    }
  };

  return {
    get sawError() {
      return errored;
    },
    onEvent(e) {
      try {
        handle(e);
      } catch (err) {
        console.warn("[claude-usage] parser error", err);
      }
    },
    finish(outcome) {
      let rid = id;
      if (!rid) {
        try {
          rid = crypto.randomUUID();
        } catch {
          rid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
      }
      return {
        id: rid,
        ts: Date.now(),
        model: model ?? meta.requestModel ?? "unknown",
        promptChars: meta.promptChars,
        outputChars,
        thinkingChars,
        status: outcome === "aborted" ? "aborted" : outcome === "error" || errored ? "error" : "ok",
        kind: meta.kind,
      };
    },
  };
}
