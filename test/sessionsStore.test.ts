import { describe, it, expect } from "vitest";
import { diffSessions, type StoredSession } from "../src/shared/sessionsStore";
import type { ParsedSession } from "../src/capture/sessionsParser";

const DAY = 86_400_000;
const ps = (updatedAt: string, isCurrent = false): ParsedSession => ({ label: "L", createdAt: "2026-01-01T00:00:00Z", updatedAt, isCurrent });
const T = Date.UTC(2026, 9, 20);
const D = "2026-10-01T00:00:00Z";

describe("diffSessions", () => {
  it("first sight is not changed", () => {
    const r = diffSessions({}, [{ key: "a", s: ps(D) }], T);
    expect(r.changed).toEqual([]);
    expect(r.store.a).toMatchObject({ firstSeen: T, lastSeen: T, lastUpdated: D, current: false });
  });
  it("forward move is changed; same/backward is not", () => {
    const p = diffSessions({}, [{ key: "a", s: ps(D) }, { key: "b", s: ps(D) }, { key: "c", s: ps(D) }], T).store;
    const r = diffSessions(p, [
      { key: "a", s: ps("2026-10-02T00:00:00Z") },
      { key: "b", s: ps(D) },
      { key: "c", s: ps("2026-09-01T00:00:00Z") },
    ], T + 1000);
    expect(r.changed).toEqual(["a"]);
    expect(r.store.a.firstSeen).toBe(T);
    expect(r.store.a.lastSeen).toBe(T + 1000);
  });
  it("excludes the current session", () => {
    const p = diffSessions({}, [{ key: "a", s: ps(D, true) }], T).store;
    expect(diffSessions(p, [{ key: "a", s: ps("2026-10-05T00:00:00Z", true) }], T + 1).changed).toEqual([]);
  });
  it("drops sessions unseen for 30 days", () => {
    const old: StoredSession = { key: "old", label: "L", createdAt: "x", lastUpdated: "x", firstSeen: 0, lastSeen: T - 31 * DAY, current: false };
    const recent: StoredSession = { ...old, key: "recent", lastSeen: T - 29 * DAY };
    const r = diffSessions({ old, recent }, [], T);
    expect(Object.keys(r.store)).toEqual(["recent"]);
  });
  it("caps at 50, dropping oldest lastSeen", () => {
    const prev: Record<string, StoredSession> = {};
    for (let i = 0; i < 50; i++) {
      prev["k" + i] = { key: "k" + i, label: "L", createdAt: "x", lastUpdated: "x", firstSeen: 0, lastSeen: T - i * 1000, current: false };
    }
    const r = diffSessions(prev, [{ key: "new", s: ps(D) }], T);
    expect(Object.keys(r.store)).toHaveLength(50);
    expect(r.store.new).toBeDefined();
    expect(r.store.k49).toBeUndefined();
    expect(r.store.k0).toBeDefined();
  });
});
