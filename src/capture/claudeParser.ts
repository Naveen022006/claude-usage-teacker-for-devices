// Maps claude.ai completion SSE events to a CapturedEvent. Stores lengths only, never text.
// Undocumented API: every path is defensive and must never throw.

import { HINT_MAX_DEPTH, HINT_MAX_KEYS, HINT_MAX_KEY_LEN, HINT_MAX_STR } from "../shared/types";
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

/** Final path segment is a chat completion (completion, retry_completion, completion_v2, ...); query ignored. */
const CHAT_COMPLETION_PATH_RE = /\/chat_conversations\/[^/]+\/(retry_)?completion(?:[_-]?v?\d+)?$/;

/** True only for URLs whose streams are real chat replies (not title generation, suggestions, etc.). */
export function isChatCompletionPath(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  let path = url;
  try {
    path = new URL(url, "https://claude.ai").pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  return CHAT_COMPLETION_PATH_RE.test(path) || COMPLETION_RE.test(url);
}

const ORG_PATH_RE = /\/api\/organizations\/([^/?#]+)/;

function isObj0(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Character length of a message content that may be a string, {text}, or an array of those. Lengths only. */
function contentLength(c: unknown, depth = 0): number {
  if (typeof c === "string") return c.length;
  if (depth > 3) return 0;
  if (Array.isArray(c)) return c.reduce<number>((n, x) => n + contentLength(x, depth + 1), 0);
  if (isObj0(c)) {
    if (typeof c.text === "string") return c.text.length;
    if (c.content !== undefined) return contentLength(c.content, depth + 1);
  }
  return 0;
}

function modelOf(o: Record<string, unknown>): string | undefined {
  const cands = [o.model, isObj0(o.completion) ? o.completion.model : undefined, isObj0(o.settings) ? o.settings.model : undefined];
  for (const c of cands) if (typeof c === "string" && c) return c;
  return undefined;
}

function promptLength(o: Record<string, unknown>): number {
  if (typeof o.prompt === "string") return o.prompt.length;
  if (isObj0(o.completion) && typeof o.completion.prompt === "string") return o.completion.prompt.length;
  if (Array.isArray(o.messages) && o.messages.length) {
    // History is resent each turn; measure only the newest message.
    const last = o.messages[o.messages.length - 1];
    return isObj0(last) ? contentLength(last.content ?? last.text) : contentLength(last);
  }
  return 0;
}

/** Tolerant request metadata for any same-origin /api/ request (never null). */
export function parseRequestMetaAny(url: string, body: unknown): RequestMeta {
  const meta: RequestMeta = { kind: "new", promptChars: 0 };
  try {
    const u = typeof url === "string" ? url : "";
    const org = ORG_PATH_RE.exec(u);
    if (org) meta.orgId = org[1];
    if (/retry_completion/.test(u)) meta.kind = "retry";
    let b: unknown = body;
    if (typeof b === "string") {
      try {
        b = JSON.parse(b);
      } catch {
        b = null;
      }
    }
    if (isObj0(b)) {
      meta.promptChars = promptLength(b);
      const m = modelOf(b);
      if (m) meta.requestModel = m;
    }
  } catch {
    /* fail soft */
  }
  return meta;
}

/** Build request metadata from the URL and parsed/raw JSON body. Returns null if not a completion URL. */
export function parseRequestMeta(url: string, body: unknown): RequestMeta | null {
  if (!isCompletionUrl(url)) return null;
  const meta = parseRequestMetaAny(url, body);
  const m = COMPLETION_RE.exec(url);
  if (m) {
    meta.orgId = m[1];
    meta.kind = m[2] ? "retry" : "new";
  }
  return meta;
}

export interface ClaudeStreamParser {
  onEvent(e: SseEvent): void;
  finish(outcome: "done" | "error" | "aborted"): CapturedEvent;
  /** True once a stream-level error event was seen. */
  readonly sawError: boolean;
  /** Events seen so far: total, how many were of a known reply type, and unique names (max 15). */
  readonly stats: { total: number; recognized: number; types: string[] };
}

/** Event names that mean "this is a reply stream" (ping alone does not count). */
const KNOWN = new Set([
  "message_start", "content_block_start", "content_block_delta", "content_block_stop",
  "message_delta", "message_stop", "completion", "error",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Dotted-key flatten of nested objects (max HINT_MAX_DEPTH levels below the root). Arrays/nulls/long strings are dropped. */
function flatten(o: Record<string, unknown>): LimitHint["fields"] {
  const fields: LimitHint["fields"] = {};
  let count = 0;
  const put = (k: string, v: unknown) => {
    if (count >= HINT_MAX_KEYS || k.length > HINT_MAX_KEY_LEN) return;
    if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
    else if (typeof v === "boolean") fields[k] = v;
    else if (typeof v === "string" && v.length <= HINT_MAX_STR) fields[k] = v;
    else return;
    count++;
  };
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (isObj(v)) {
        if (depth < HINT_MAX_DEPTH) walk(v, key, depth + 1);
      } else put(key, v);
    }
  };
  walk(o, "", 0);
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
  let total = 0;
  let recognized = 0;
  const types = new Set<string>();

  const handle = (e: SseEvent) => {
    let j: unknown;
    try {
      j = e.data ? JSON.parse(e.data) : {};
    } catch {
      console.warn("[claude-usage] bad JSON in SSE event", e.event);
      return;
    }
    if (!isObj(j)) return;
    total++;
    const jt = typeof j.type === "string" ? j.type : "";
    const name = e.event !== "message" && (KNOWN.has(e.event) || !KNOWN.has(jt)) ? e.event : jt || e.event;
    if (types.size < 15) types.add(name.slice(0, 40));
    if (KNOWN.has(name) || name.includes("limit")) recognized++;
    // Model may sit in message_start.message.model, data.model or data.message.model.
    if (!model) {
      const m1 = isObj(j.message) && typeof j.message.model === "string" ? j.message.model : undefined;
      const m2 = typeof j.model === "string" ? j.model : undefined;
      model = m1 || m2 || undefined;
    }

    switch (name) {
      case "completion": {
        // Legacy claude.ai style: {"type":"completion","completion":"...","model":"..."}
        if (typeof j.completion === "string") outputChars += j.completion.length;
        return;
      }
      case "message_start": {
        const msg = isObj(j.message) ? j.message : {};
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
    get stats() {
      return { total, recognized, types: [...types] };
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
