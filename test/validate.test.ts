import { describe, it, expect } from "vitest";
import { validateCapturedEvent, validatePageMessage } from "../src/shared/validate";

const good = {
  id: "msg_1", ts: 1760000000000, model: "claude-sonnet-5-5",
  promptChars: 10, outputChars: 20, thinkingChars: 0, status: "ok", kind: "new",
};
const wrap = (type: string, payload: unknown) => ({ ns: "claude-usage", type, payload });

describe("validateCapturedEvent", () => {
  it("accepts a good event and strips extra keys", () => {
    expect(validateCapturedEvent({ ...good, text: "secret" })).toEqual(good);
  });
  it.each([
    ["non-object", "x"],
    ["null", null],
    ["array", []],
    ["string number", { ...good, ts: "1" }],
    ["negative", { ...good, promptChars: -1 }],
    ["NaN", { ...good, outputChars: NaN }],
    ["Infinity", { ...good, thinkingChars: Infinity }],
    ["bad status", { ...good, status: "weird" }],
    ["bad kind", { ...good, kind: "x" }],
    ["long model", { ...good, model: "m".repeat(101) }],
    ["long id", { ...good, id: "i".repeat(201) }],
    ["empty id", { ...good, id: "" }],
    ["non-string model", { ...good, model: 5 }],
  ])("rejects %s", (_n, x) => {
    expect(validateCapturedEvent(x)).toBeNull();
  });
  it("accepts boundary lengths", () => {
    expect(validateCapturedEvent({ ...good, model: "m".repeat(100), id: "i".repeat(200) })).not.toBeNull();
  });
});

describe("validatePageMessage", () => {
  it("accepts usage-event", () => {
    expect(validatePageMessage(wrap("usage-event", good))?.type).toBe("usage-event");
  });
  it("rejects wrong namespace / unknown type", () => {
    expect(validatePageMessage({ ...wrap("usage-event", good), ns: "other" })).toBeNull();
    expect(validatePageMessage(wrap("nope", good))).toBeNull();
    expect(validatePageMessage(undefined)).toBeNull();
  });
  it("validates orgId", () => {
    expect(validatePageMessage(wrap("org-seen", { orgId: "abc-123" }))).not.toBeNull();
    expect(validatePageMessage(wrap("org-seen", { orgId: "a/b" }))).toBeNull();
    expect(validatePageMessage(wrap("org-seen", { orgId: "../x" }))).toBeNull();
    expect(validatePageMessage(wrap("org-seen", { orgId: "a".repeat(65) }))).toBeNull();
    expect(validatePageMessage(wrap("org-seen", { orgId: "" }))).toBeNull();
    expect(validatePageMessage(wrap("org-seen", { orgId: 5 }))).toBeNull();
  });
  describe("limit-hint", () => {
    const hint = (fields: unknown) => wrap("limit-hint", { ts: 1, fields });
    it("accepts flat primitives", () => {
      expect(validatePageMessage(hint({ a: "x", b: 1, c: true }))).not.toBeNull();
    });
    it("rejects nested objects, arrays, null", () => {
      expect(validatePageMessage(hint({ a: { b: 1 } }))).toBeNull();
      expect(validatePageMessage(hint({ a: [1] }))).toBeNull();
      expect(validatePageMessage(hint({ a: null }))).toBeNull();
    });
    it("rejects long strings and too many keys", () => {
      expect(validatePageMessage(hint({ a: "x".repeat(65) }))).toBeNull();
      const many = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, i]));
      expect(validatePageMessage(hint(many))).toBeNull();
    });
    it("accepts 48 keys, dotted keys up to 80 chars; rejects longer keys and NaN/Infinity", () => {
      const ok = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`message_limit.windows.5h.k${i}`, i]));
      expect(validatePageMessage(hint(ok))).not.toBeNull();
      expect(validatePageMessage(hint({ ["a".repeat(80)]: 1 }))).not.toBeNull();
      expect(validatePageMessage(hint({ ["a".repeat(81)]: 1 }))).toBeNull();
      expect(validatePageMessage(hint({ a: Infinity }))).toBeNull();
    });
  });
});
