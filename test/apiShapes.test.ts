import { describe, it, expect } from "vitest";
import { ApiShapeRing, isSettingsPath, looksLikeSessionList, shapeOf } from "../src/capture/apiShapes";
import { validateDiag } from "../src/shared/validate";
import type { ApiShapeObservation } from "../src/shared/types";

const sessions = {
  sessions: [
    { id: "lorem-1", device_label: "lorem ipsum", location: "dolor", created_at: "2026-01-01", updated_at: "2026-01-02", is_current: true },
    { id: "lorem-2", device_label: "sit amet" },
  ],
  total: 123,
};
const conversations = [{ uuid: "lorem", name: "dolor sit", model: "amet", created_at: "x" }];

const obs = (p: string, n = 1): ApiShapeObservation => ({
  at: n, method: "GET", pathPattern: p, status: 200, shape: shapeOf(sessions), looksLikeSessionList: true,
});

describe("isSettingsPath", () => {
  it("matches settings only", () => {
    expect(isSettingsPath("/settings/account")).toBe(true);
    expect(isSettingsPath("/chat/abc")).toBe(false);
  });
});

describe("shapeOf", () => {
  it("never contains input values and uses the first array element", () => {
    const s = shapeOf(sessions);
    const json = JSON.stringify(s);
    for (const v of ["lorem", "ipsum", "dolor", "2026", "sit amet"]) expect(json).not.toContain(v);
    expect(s.total).toBe("number");
    const arr = s.sessions as Record<string, unknown>;
    expect(arr["(array)"]).toBe("array(2)");
    expect(Object.keys(arr["[0]"] as object)).toContain("device_label");
  });
  it("caps depth at 3 levels", () => {
    const s = shapeOf({ a: { b: { c: { d: 1 } } } }) as any;
    expect(s.a.b.c).toBe("object");
  });
  it("caps keys and key length", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big["k" + i] = i;
    expect(Object.keys(shapeOf(big)).length).toBe(40);
    expect(Object.keys(shapeOf({ ["y".repeat(100)]: 1 }))[0]!.length).toBe(40);
  });
  it("handles primitives, null and hostile input without throwing", () => {
    expect(shapeOf("secret")).toEqual({ "(root)": "string" });
    expect(shapeOf(null)).toEqual({ "(root)": "null" });
    const evil = { get boom(): never { throw new Error("x"); } };
    expect(shapeOf(evil)).toEqual({ "(error)": "unreadable" });
  });
});

describe("looksLikeSessionList", () => {
  it("true for a sessions array, false for conversations", () => {
    expect(looksLikeSessionList(shapeOf(sessions))).toBe(true);
    expect(looksLikeSessionList(shapeOf(conversations))).toBe(false);
  });
});

describe("ApiShapeRing", () => {
  it("dedupes by method+path keeping the newest, newest last", () => {
    const r = new ApiShapeRing();
    r.add(obs("/api/a", 1));
    r.add(obs("/api/b", 2));
    r.add(obs("/api/a", 3));
    expect(r.list().map((o) => o.pathPattern)).toEqual(["/api/b", "/api/a"]);
    expect(r.list()[1]!.at).toBe(3);
  });
  it("caps at 20", () => {
    const r = new ApiShapeRing();
    for (let i = 0; i < 30; i++) r.add(obs("/api/p" + i, i));
    expect(r.list().length).toBe(20);
    expect(r.list()[19]!.pathPattern).toBe("/api/p29");
  });
});

describe("validateDiag apiShapes", () => {
  const base = { updatedAt: 1, hookInstalled: true, fetchCalls: 0, streamsSeen: 0, emptyStreams: 0, eventsPosted: 0, observations: [] };
  it("keeps good entries and drops malformed ones", () => {
    const d = validateDiag({
      ...base,
      apiShapes: [
        obs("/api/ok"),
        { ...obs("/api/post"), method: "POST" },
        { ...obs("/api/status"), status: "200" },
        { ...obs("/api/long"), pathPattern: "p".repeat(201) },
        { ...obs("/api/flag"), looksLikeSessionList: "yes" },
        "junk",
      ],
    });
    expect(d?.apiShapes?.map((o) => o.pathPattern)).toEqual(["/api/ok"]);
  });
  it("drops non-type leaves and over-deep shapes", () => {
    const d = validateDiag({
      ...base,
      apiShapes: [{ ...obs("/api/x"), shape: { good: "string", leak: "my secret value", deep: { a: { b: { c: "string" } } } } }],
    });
    const shape = d!.apiShapes![0]!.shape as any;
    expect(shape.good).toBe("string");
    expect(shape.leak).toBeUndefined();
    expect(shape.deep.a.b).toBeUndefined();
  });
  it("caps entries at 20 and never throws on garbage", () => {
    const many = Array.from({ length: 30 }, (_, i) => obs("/api/" + i));
    expect(validateDiag({ ...base, apiShapes: many })!.apiShapes!.length).toBe(20);
    expect(validateDiag({ ...base, apiShapes: "nope" })!.apiShapes).toBeUndefined();
  });
});
