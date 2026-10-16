import { describe, it, expect, vi } from "vitest";
import { SseParser } from "../src/capture/sse";
import { createClaudeStreamParser, isCompletionUrl, parseRequestMeta } from "../src/capture/claudeParser";
import type { RequestMeta } from "../src/capture/claudeParser";
import type { CapturedEvent, LimitHint } from "../src/shared/types";
import { readFileSync } from "node:fs";

const fixture = (n: string): string => readFileSync(new URL(`./fixtures/${n}.sse`, import.meta.url), "utf8");
const META: RequestMeta = { kind: "new", promptChars: 42, requestModel: "claude-req-model" };

function run(
  name: string,
  opts: { meta?: RequestMeta; chunk?: number; outcome?: "done" | "error" | "aborted" } = {},
): { ev: CapturedEvent; hints: LimitHint[] } {
  const hints: LimitHint[] = [];
  const parser = createClaudeStreamParser(opts.meta ?? META, (h) => hints.push(h));
  const sse = new SseParser();
  const text = fixture(name);
  const size = opts.chunk ?? text.length;
  for (let i = 0; i < text.length; i += size) for (const e of sse.push(text.slice(i, i + size))) parser.onEvent(e);
  for (const e of sse.flush()) parser.onEvent(e);
  return { ev: parser.finish(opts.outcome ?? "done"), hints };
}

describe("claude stream parser", () => {
  it("parses a normal reply", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ev } = run("normal");
    expect(ev).toMatchObject({
      id: "msg_01SyntheticAAAA",
      model: "claude-sonnet-5-5",
      promptChars: 42,
      outputChars: 56,
      thinkingChars: 0,
      status: "ok",
      kind: "new",
    });
    expect(Math.abs(ev.ts - Date.now())).toBeLessThan(5000);
    vi.restoreAllMocks();
  });

  it("counts thinking separately", () => {
    const { ev } = run("thinking");
    expect(ev.thinkingChars).toBe(70);
    expect(ev.outputChars).toBe(27);
  });

  it("is invariant to chunk size", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["normal", "thinking", "error", "limit", "unknown-events"]) {
      const base = run(name);
      for (const chunk of [1, 3, 17, 100]) {
        const r = run(name, { chunk });
        expect({ ...r.ev, ts: 0 }).toEqual({ ...base.ev, ts: 0 });
        expect(r.hints.map((h) => h.fields)).toEqual(base.hints.map((h) => h.fields));
      }
    }
    vi.restoreAllMocks();
  });

  it("marks a stream error event as status error and keeps partial counts", () => {
    const { ev } = run("error");
    expect(ev.status).toBe("error");
    expect(ev.outputChars).toBe(17);
  });

  it("honours error / aborted outcomes", () => {
    expect(run("normal", { outcome: "aborted" }).ev.status).toBe("aborted");
    expect(run("normal", { outcome: "error" }).ev.status).toBe("error");
  });

  it("carries retry kind", () => {
    expect(run("normal", { meta: { ...META, kind: "retry" } }).ev.kind).toBe("retry");
  });

  it("ignores unknown events and bad JSON without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ev } = run("unknown-events");
    expect(ev.outputChars).toBe(17);
    expect(ev.status).toBe("ok");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.every((c) => String(c[0]).startsWith("[claude-usage]"))).toBe(true);
    warn.mockRestore();
  });

  it("emits a flat limit hint with no long strings", () => {
    const { hints } = run("limit");
    expect(hints).toHaveLength(1);
    const f = hints[0].fields;
    expect(f["type"]).toBe("message_limit");
    expect(f["message_limit.type"]).toBe("within_limit");
    for (const [k, v] of Object.entries(f)) {
      expect(["string", "number", "boolean"]).toContain(typeof v);
      expect(k.split(".").length).toBeLessThanOrEqual(4);
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(64);
    }
    expect("message_limit.resetsAt" in f).toBe(false); // nulls dropped
  });

  it("flattens up to 3 levels deep, dropping long strings, arrays and deeper objects", () => {
    const hints: LimitHint[] = [];
    const p = createClaudeStreamParser(META, (h) => hints.push(h));
    p.onEvent({
      event: "message_limit",
      data: JSON.stringify({
        a: "x".repeat(65), b: 1, arr: [1], nul: null,
        c: { d: true, e: { f: 1, g: { h: 2, i: { j: 3 } } }, k: "ok" },
      }),
    });
    expect(hints[0].fields).toEqual({ b: 1, "c.d": true, "c.e.f": 1, "c.e.g.h": 2, "c.k": "ok" });
  });

  it("captures message_limit windows", () => {
    const hints: LimitHint[] = [];
    const p = createClaudeStreamParser(META, (h) => hints.push(h));
    p.onEvent({
      event: "message_limit",
      data: JSON.stringify({ type: "message_limit", message_limit: { type: "approaching_limit", windows: { "5h": { status: "within", resets_at: 1800000000, utilization: 0.42 } } } }),
    });
    expect(hints[0].fields["message_limit.windows.5h.utilization"]).toBe(0.42);
    expect(hints[0].fields["message_limit.windows.5h.resets_at"]).toBe(1800000000);
  });

  it("caps hints at 48 keys and 80-char keys", () => {
    const hints: LimitHint[] = [];
    const p = createClaudeStreamParser(META, (h) => hints.push(h));
    const o: Record<string, number> = { ["k".repeat(81)]: 1 };
    for (let i = 0; i < 60; i++) o[`k${i}`] = i;
    p.onEvent({ event: "message_limit", data: JSON.stringify(o) });
    expect(Object.keys(hints[0].fields)).toHaveLength(48);
    expect(Object.keys(hints[0].fields).every((k) => k.length <= 80)).toBe(true);
  });

  it("detects event type from data.type when no event: field is given", () => {
    const p = createClaudeStreamParser(META);
    p.onEvent({ event: "message", data: '{"type":"message_start","message":{"id":"m1","model":"mx"}}' });
    p.onEvent({
      event: "message",
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"abc"}}',
    });
    expect(p.finish("done")).toMatchObject({ id: "m1", model: "mx", outputChars: 3 });
  });

  it("treats text deltas in a thinking block as thinking", () => {
    const p = createClaudeStreamParser(META);
    p.onEvent({ event: "content_block_start", data: '{"index":0,"content_block":{"type":"thinking"}}' });
    p.onEvent({ event: "content_block_delta", data: '{"index":0,"delta":{"text":"abcd"}}' });
    const ev = p.finish("done");
    expect(ev.thinkingChars).toBe(4);
    expect(ev.outputChars).toBe(0);
  });

  it("falls back: stream model -> request model -> unknown", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(run("normal").ev.model).toBe("claude-sonnet-5-5");
    vi.restoreAllMocks();
    expect(createClaudeStreamParser(META).finish("done").model).toBe("claude-req-model");
    expect(createClaudeStreamParser({ kind: "new", promptChars: 0 }).finish("done").model).toBe("unknown");
  });

  it("falls back to a uuid when there is no message id", () => {
    const a = createClaudeStreamParser(META).finish("done").id;
    const b = createClaudeStreamParser(META).finish("done").id;
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("never throws on weird payloads and never stores text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = createClaudeStreamParser(META);
    for (const data of ["null", "[]", "42", '"s"', "{", '{"delta":5}', '{"message":"x"}']) {
      for (const event of ["message_start", "content_block_delta", "content_block_start", "message_limit", "x"]) {
        expect(() => p.onEvent({ event, data })).not.toThrow();
      }
    }
    const ev = p.finish("done");
    expect(Object.values(ev).every((v) => typeof v === "string" || typeof v === "number")).toBe(true);
    warn.mockRestore();
  });
});

describe("request helpers", () => {
  const base = "https://claude.ai/api/organizations/org-123/chat_conversations/conv-9/";

  it("isCompletionUrl", () => {
    expect(isCompletionUrl(base + "completion")).toBe(true);
    expect(isCompletionUrl(base + "retry_completion")).toBe(true);
    expect(isCompletionUrl("/api/organizations/o/chat_conversations/c/completion?x=1")).toBe(true);
    expect(isCompletionUrl(base + "title")).toBe(false);
    expect(isCompletionUrl("https://claude.ai/api/organizations/o/usage")).toBe(false);
    expect(isCompletionUrl("")).toBe(false);
  });

  it("parseRequestMeta reads org, kind, model and prompt length", () => {
    const body = JSON.stringify({ prompt: "hello", model: "claude-opus-x", attachments: [] });
    expect(parseRequestMeta(base + "completion", body)).toEqual({
      kind: "new",
      requestModel: "claude-opus-x",
      promptChars: 5,
      orgId: "org-123",
    });
    expect(parseRequestMeta(base + "retry_completion", { prompt: "ab" })).toEqual({
      kind: "retry",
      promptChars: 2,
      orgId: "org-123",
    });
  });

  it("parseRequestMeta is tolerant", () => {
    expect(parseRequestMeta("https://claude.ai/other", "{}")).toBeNull();
    expect(parseRequestMeta(base + "completion", "not json")).toEqual({ kind: "new", promptChars: 0, orgId: "org-123" });
    expect(parseRequestMeta(base + "completion", undefined)?.promptChars).toBe(0);
    expect(parseRequestMeta(base + "completion", { model: 5, prompt: 7 })).toEqual({
      kind: "new",
      promptChars: 0,
      orgId: "org-123",
    });
  });
});
