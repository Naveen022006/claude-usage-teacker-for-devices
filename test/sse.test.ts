import { describe, it, expect } from "vitest";
import { SseParser } from "../src/capture/sse";
import type { SseEvent } from "../src/capture/sse";
import { readFileSync } from "node:fs";

const fixture = (n: string): string => readFileSync(new URL(`./fixtures/${n}.sse`, import.meta.url), "utf8");

function parseAll(text: string, size = Infinity): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  if (size === Infinity) out.push(...p.push(text));
  else for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  out.push(...p.flush());
  return out;
}

describe("SseParser", () => {
  it("parses a basic event", () => {
    expect(parseAll("event: foo\ndata: bar\n\n")).toEqual([{ event: "foo", data: "bar" }]);
  });

  it("defaults event name to message", () => {
    expect(parseAll("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("joins multiple data lines with newline", () => {
    expect(parseAll("data: a\ndata: b\ndata:c\n\n")[0].data).toBe("a\nb\nc");
  });

  it("strips only one optional space after the colon", () => {
    expect(parseAll("data:  two\n\n")[0].data).toBe(" two");
    expect(parseAll("data:none\n\n")[0].data).toBe("none");
  });

  it("handles empty data", () => {
    expect(parseAll("event: e\ndata:\n\n")).toEqual([{ event: "e", data: "" }]);
    expect(parseAll("event: e\ndata\n\n")).toEqual([{ event: "e", data: "" }]);
  });

  it("ignores comment lines", () => {
    expect(parseAll(": keepalive\nevent: a\n: hi\ndata: 1\n\n")).toEqual([{ event: "a", data: "1" }]);
    expect(parseAll(": only comment\n\n")).toEqual([]);
  });

  it("captures id", () => {
    expect(parseAll("id: 7\ndata: x\n\n")).toEqual([{ event: "message", data: "x", id: "7" }]);
  });

  it("handles CRLF, CR and LF at any chunk size", () => {
    const expected = [
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ];
    for (const nl of ["\r\n", "\r", "\n"]) {
      const text = ["event: a", "data: 1", "", "event: b", "data: 2", "", ""].join(nl);
      expect(parseAll(text)).toEqual(expected);
      for (const size of [1, 2, 3, 5]) expect(parseAll(text, size)).toEqual(expected);
    }
  });

  it("handles a chunk split between CR and LF", () => {
    const p = new SseParser();
    const out = [...p.push("data: x\r"), ...p.push("\n\r"), ...p.push("\ndata: y\r\n\r\n")];
    expect(out).toEqual([
      { event: "message", data: "x" },
      { event: "message", data: "y" },
    ]);
  });

  it("handles chunks split mid-line and mid-event", () => {
    const p = new SseParser();
    expect(p.push("eve")).toEqual([]);
    expect(p.push("nt: ping\nda")).toEqual([]);
    expect(p.push('ta: {"a":1}\n')).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "ping", data: '{"a":1}' }]);
  });

  it("flush emits a trailing unterminated event", () => {
    const p = new SseParser();
    expect(p.push("event: x\ndata: tail")).toEqual([]);
    expect(p.flush()).toEqual([{ event: "x", data: "tail" }]);
    expect(p.flush()).toEqual([]);
  });

  it("does not leak state between events", () => {
    const evs = parseAll("event: a\nid: 1\ndata: x\n\ndata: y\n\n");
    expect(evs[1]).toEqual({ event: "message", data: "y" });
  });

  it("never throws on junk", () => {
    const p = new SseParser();
    expect(() => {
      p.push("\0\u{1F600}::::\n\n\r\r\n");
      p.push(undefined as unknown as string);
      p.flush();
    }).not.toThrow();
  });

  it("gives identical results for fixtures at any chunk size", () => {
    for (const name of ["normal", "thinking", "error", "limit", "unknown-events"]) {
      const text = fixture(name);
      const whole = parseAll(text);
      expect(whole.length).toBeGreaterThan(2);
      for (const size of [1, 2, 3, 7, 13, 64, 500]) expect(parseAll(text, size)).toEqual(whole);
      const p = new SseParser();
      const out: SseEvent[] = [];
      for (let i = 0; i < text.length; ) {
        const n = 1 + Math.floor(Math.random() * 20);
        out.push(...p.push(text.slice(i, i + n)));
        i += n;
      }
      out.push(...p.flush());
      expect(out).toEqual(whole);
    }
  });
});
