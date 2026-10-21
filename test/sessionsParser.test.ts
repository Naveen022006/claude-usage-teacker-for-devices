import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseSessions, sessionKey, SESSIONS_PATH } from "../src/capture/sessionsParser";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sessions-list-active.json", import.meta.url), "utf8"));

describe("parseSessions", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const r = parseSessions(fixture)!;

  it("exports the path", () => expect(SESSIONS_PATH).toBe("/api/auth/sessions/list-active"));
  it("labels and skips malformed entries", () => {
    expect(r.sessions.map((s) => s.label)).toEqual(["Chrome (Windows)", "Claude Desktop (Windows)", "Claude (iOS)", "Edge (Windows)", "Chrome (Mac OS X)", "Browser"]);
  });
  it("flags current", () => expect(r.sessions.map((s) => s.isCurrent)).toEqual([true, false, false, false, false, false]));
  it("reports hasMore and uaKeys", () => {
    expect(r.hasMore).toBe(true);
    expect(r.uaKeys).toEqual(["browser_family", "browser_version", "device_family", "is_bot", "os_family", "os_version", "zz_weird"]);
  });
  it("leaks no uuid, location or expiry", () => {
    const out = JSON.stringify(r);
    for (const bad of ["SESSIONUUID", "Loremville", "lorem ipsum", "Ipsumtown", "consectetur", "EXPIRYFIX", "expires", "location"]) {
      expect(out).not.toContain(bad);
    }
    expect(Object.keys(r.sessions[0]).sort()).toEqual(["createdAt", "isCurrent", "label", "updatedAt"]);
  });
  it("returns null on garbage", () => {
    for (const g of [null, undefined, 5, "x", [], {}, { data: "no" }]) expect(parseSessions(g)).toBeNull();
  });
  it("falls back to Unknown device", () => {
    const x = parseSessions({ data: [{ created_at: "2026-01-01", updated_at: "2026-01-02" }] })!;
    expect(x.sessions[0].label).toBe("Unknown device");
    expect(x.hasMore).toBe(false);
  });
});

describe("sessionKey", () => {
  const s = { label: "Chrome (Windows)", createdAt: "2026-10-01T08:00:00Z", updatedAt: "x", isCurrent: false };
  it("is deterministic, salt-dependent and well-formed", async () => {
    const a = await sessionKey("salt", s);
    expect(a).toMatch(/^session:[0-9a-f]{24}$/);
    expect(await sessionKey("salt", { ...s, updatedAt: "y" })).toBe(a);
    expect(await sessionKey("other", s)).not.toBe(a);
    expect(await sessionKey("salt", { ...s, label: "Edge" })).not.toBe(a);
  });
});
