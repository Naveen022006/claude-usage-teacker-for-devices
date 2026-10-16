import { describe, it, expect } from "vitest";
import { mergeEvents, parseTranscriptLine } from "../src/transcript";

import { asst } from "./fixtures";

describe("parseTranscriptLine", () => {
  it("parses an assistant line", () => {
    const e = parseTranscriptLine(asst("msg_1", 50), "dev")!;
    expect(e).toMatchObject({
      id: "msg_1",
      ts: Date.parse("2026-10-01T10:00:00.000Z"),
      source: "claude-code",
      deviceId: "dev",
      model: "claude-sonnet-5-5",
      promptTokens: 1103,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 100,
      estimated: false,
      status: "ok",
      kind: "new",
      promptChars: 0,
    });
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });
  it("flags api errors", () => {
    expect(parseTranscriptLine(asst("m", 1, { isApiErrorMessage: true }), "d")!.status).toBe("error");
  });
  it("skips synthetic, user, malformed, and incidental 'assistant' text", () => {
    expect(parseTranscriptLine(asst("m", 1, {}, "<synthetic>"), "d")).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: "user", message: { role: "user", content: 'the "assistant" said hi' } }), "d")).toBeNull();
    expect(parseTranscriptLine('{"type":"assistant", broken', "d")).toBeNull();
    expect(parseTranscriptLine("", "d")).toBeNull();
    expect(parseTranscriptLine(asst("m", 1, { timestamp: "nope" }), "d")).toBeNull();
  });
  it("coerces bad numbers to 0", () => {
    const l = JSON.stringify({ type: "assistant", timestamp: "2026-10-01T00:00:00Z", message: { id: "x", model: "m", usage: { input_tokens: -5, output_tokens: "7", cache_read_input_tokens: NaN } } });
    expect(parseTranscriptLine(l, "d")).toMatchObject({ promptTokens: 0, outputTokens: 0 });
  });
  it("requires usage and id", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant", timestamp: "2026-10-01T00:00:00Z", message: { id: "x", model: "m" } }), "d")).toBeNull();
  });
});

describe("mergeEvents", () => {
  it("dedupes by id keeping larger tokens and earliest ts, sorted", () => {
    const a = parseTranscriptLine(asst("a", 5, {}, "m", "2026-10-01T10:00:02Z"), "d")!;
    const a2 = parseTranscriptLine(asst("a", 50, {}, "m", "2026-10-01T10:00:05Z"), "d")!;
    const a3 = parseTranscriptLine(asst("a", 20, {}, "m", "2026-10-01T10:00:01Z"), "d")!;
    const b = parseTranscriptLine(asst("b", 1, {}, "m", "2026-10-01T09:00:00Z"), "d")!;
    const out = mergeEvents([a, b], [a2, a3]);
    expect(out.map((e) => e.id)).toEqual(["b", "a"]);
    const m = out[1];
    expect(m.outputTokens).toBe(50);
    expect(m.ts).toBe(Date.parse("2026-10-01T10:00:01Z"));
  });
});
