import { describe, it, expect, vi } from "vitest";
import { SseParser } from "../src/capture/sse";
import { createClaudeStreamParser, isChatCompletionPath, parseRequestMeta, parseRequestMetaAny } from "../src/capture/claudeParser";
import { DiagState, pathPattern } from "../src/capture/diag";
import { explainCapturedEventError, validateDiag, validatePageMessage } from "../src/shared/validate";

function runText(text: string) {
  const parser = createClaudeStreamParser({ kind: "new", promptChars: 5 });
  const sse = new SseParser();
  for (const e of [...sse.push(text), ...sse.flush()]) parser.onEvent(e);
  return { ev: parser.finish("done"), stats: parser.stats };
}

describe("tolerant SSE parsing", () => {
  it("legacy completion style sums lengths and takes model", () => {
    const t =
      'data: {"type":"completion","completion":"Lorem ","model":"claude-3-5-sonnet-20241022","stop_reason":null}\n\n' +
      'data: {"type":"completion","completion":"ipsum","model":"claude-3-5-sonnet-20241022","stop_reason":null}\n\n' +
      'data: {"type":"completion","completion":"","stop_reason":"stop_sequence"}\n\n';
    const { ev, stats } = runText(t);
    expect(ev.outputChars).toBe(11);
    expect(ev.model).toBe("claude-3-5-sonnet-20241022");
    expect(stats.recognized).toBe(3);
  });
  it("legacy style with event: completion lines", () => {
    const { ev } = runText('event: completion\ndata: {"completion":"abc","model":"claude-x"}\n\n');
    expect(ev.outputChars).toBe(3);
    expect(ev.model).toBe("claude-x");
  });
  it("Messages style without event: lines", () => {
    const t =
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5"}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Lorem ipsum"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const { ev, stats } = runText(t);
    expect(ev).toMatchObject({ id: "msg_1", model: "claude-sonnet-5-5", outputChars: 11 });
    expect(stats.types).toEqual(["message_start", "content_block_start", "content_block_delta", "message_stop"]);
  });
  it("model from data.message.model on any event", () => {
    const { ev } = runText('data: {"type":"message_delta","message":{"model":"claude-m"}}\n\n');
    expect(ev.model).toBe("claude-m");
  });
  it("unknown-only streams have zero recognized events", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stats } = runText('data: {"type":"foo"}\n\ndata: {"type":"ping"}\n\n');
    expect(stats.total).toBe(2);
    expect(stats.recognized).toBe(0);
    expect(stats.types).toEqual(["foo", "ping"]);
    vi.restoreAllMocks();
  });
});

describe("request meta variants", () => {
  const url = "https://claude.ai/api/organizations/org-1/chat_conversations/c1/completion";
  it("model locations", () => {
    expect(parseRequestMeta(url, JSON.stringify({ model: "a" }))?.requestModel).toBe("a");
    expect(parseRequestMeta(url, { completion: { model: "b" } })?.requestModel).toBe("b");
    expect(parseRequestMeta(url, { settings: { model: "c" } })?.requestModel).toBe("c");
    expect(parseRequestMeta(url, {})?.requestModel).toBeUndefined();
  });
  it("prompt lengths from prompt or messages (lengths only)", () => {
    expect(parseRequestMeta(url, { prompt: "12345" })?.promptChars).toBe(5);
    expect(parseRequestMeta(url, { messages: [{ content: "old old" }, { content: "abcd" }] })?.promptChars).toBe(4);
    expect(parseRequestMeta(url, { messages: [{ content: [{ text: "ab" }, { text: "cde" }] }] })?.promptChars).toBe(5);
    expect(parseRequestMeta(url, "not json")?.promptChars).toBe(0);
  });
  it("any /api/ url yields meta with org", () => {
    const m = parseRequestMetaAny("https://claude.ai/api/organizations/org-9/foo/stream", { model: "z" });
    expect(m).toMatchObject({ orgId: "org-9", requestModel: "z", kind: "new" });
    expect(parseRequestMeta("https://claude.ai/api/other", {})).toBeNull();
  });
});

describe("pathPattern redaction", () => {
  it("replaces uuids, digits and long ids", () => {
    const p = pathPattern(
      "https://claude.ai/api/organizations/6f1c2d3e-1111-4222-8333-444455556666/chat_conversations/0a1b2c3d-1111-4222-8333-444455556666/completion?x=secret",
    );
    expect(p).toBe("/api/organizations/:id/chat_conversations/:id/completion");
    expect(pathPattern("/api/foo/12345/bar")).toBe("/api/foo/:id/bar");
    expect(pathPattern("/api/bootstrap/org_01ABCDEFGH23/x")).toBe("/api/bootstrap/:id/x");
    expect(pathPattern("/api/a/token")).toBe("/api/a/token");
  });
  it("DiagState ring keeps the last 20", () => {
    const d = new DiagState();
    for (let i = 0; i < 25; i++) d.observe({ pathPattern: "/api/x", contentType: "", status: 200, matchedRegex: false, eventTypes: [], recorded: false });
    expect(d.snapshot().observations).toHaveLength(20);
  });
});

describe("diag validation", () => {
  const d = new DiagState();
  d.hookInstalled = true;
  d.observe({ pathPattern: "/api/x", contentType: "text/event-stream", status: 200, matchedRegex: true, eventTypes: ["a"], recorded: true });
  const snap = d.snapshot();
  it("accepts a good diag message and strips extras", () => {
    const m = validatePageMessage({ ns: "claude-usage", type: "diag", payload: { ...snap, extra: 1 } });
    expect(m?.type).toBe("diag");
    expect(m && "extra" in (m.payload as object)).toBe(false);
  });
  it.each([
    ["too many observations", { ...snap, observations: Array(21).fill(snap.observations[0]) }],
    ["bad counter", { ...snap, fetchCalls: -1 }],
    ["long path", { ...snap, observations: [{ ...snap.observations[0], pathPattern: "x".repeat(201) }] }],
    ["too many event types", { ...snap, observations: [{ ...snap.observations[0], eventTypes: Array(16).fill("a") }] }],
    ["non-bool", { ...snap, hookInstalled: "yes" }],
  ])("rejects %s", (_n, x) => {
    expect(validateDiag(x)).toBeNull();
  });
  it("explains event rejection reasons", () => {
    expect(explainCapturedEventError({ id: "a", model: "", ts: 1 })).toBe("bad model");
    expect(explainCapturedEventError(null)).toBe("payload is not an object");
  });
});

describe("only chat completion paths are recorded", () => {
  const O = "https://claude.ai/api/organizations/org-1/chat_conversations/c1/";
  it.each([
    ["completion", true], ["retry_completion", true], ["completion_v2", true], ["completion?x=1", true],
    ["title", false], ["suggestions", false],
  ])("isChatCompletionPath %s", (s, ok) => {
    expect(isChatCompletionPath(O + s)).toBe(ok);
  });

  async function drive(path: string, model: string) {
    vi.resetModules();
    const posted: any[] = [];
    const sse =
      `data: {"type":"message_start","message":{"id":"m1","model":"${model}"}}\n\n` +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const fake = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const w: any = { fetch: fake, postMessage: (m: any) => posted.push(m) };
    vi.stubGlobal("window", w);
    vi.stubGlobal("location", { origin: "https://claude.ai", href: "https://claude.ai/chat/c1" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    await import("../src/capture/inject");
    const res: Response = await w.fetch("https://claude.ai" + path, { method: "POST", body: "{}" });
    await res.text();
    await new Promise((r) => setTimeout(r, 1200));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const events = posted.filter((m) => m.type === "usage-event").map((m) => m.payload);
    const diags = posted.filter((m) => m.type === "diag");
    return { events, obs: diags[diags.length - 1]?.payload.observations ?? [] };
  }
  const base = "/api/organizations/6f1c2d3e-1111-4222-8333-444455556666/chat_conversations/0a1b2c3d-1111-4222-8333-444455556666/";

  it("title-generation stream is observed but not recorded", async () => {
    const r = await drive(base + "title", "claude-haiku-5-5");
    expect(r.events).toHaveLength(0);
    expect(r.obs[0]).toMatchObject({ pathPattern: "/api/organizations/:id/chat_conversations/:id/title", recorded: false, reason: "not a chat completion path" });
  });
  it("completion is recorded", async () => {
    const r = await drive(base + "completion", "claude-sonnet-5-5");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ model: "claude-sonnet-5-5", kind: "new" });
    expect(r.obs[0].recorded).toBe(true);
  });
  it("retry_completion is recorded as retry", async () => {
    const r = await drive(base + "retry_completion", "claude-sonnet-5-5");
    expect(r.events[0]).toMatchObject({ kind: "retry" });
  });
  it("completion_v2 is recorded", async () => {
    const r = await drive(base + "completion_v2", "claude-sonnet-5-5");
    expect(r.events).toHaveLength(1);
  });
});
