import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBase, ping, sendReport } from "../src/sync/hub";
import type { Report } from "../src/shared/types";

afterEach(() => vi.unstubAllGlobals());
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const report = { v: 1, deviceId: "d" } as unknown as Report;

describe("hub client", () => {
  it("normalizeBase defaults to https and strips slashes", () => {
    expect(normalizeBase(" my-hub.vercel.app/ ")).toBe("https://my-hub.vercel.app");
    expect(normalizeBase("http://127.0.0.1:8787//")).toBe("http://127.0.0.1:8787");
    expect(normalizeBase("")).toBe("");
  });

  it("sends a Bearer token and succeeds on 200 {ok:true}", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal("fetch", f);
    expect(await sendReport("https://h.example", "tok", report)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h.example/api/report");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-DeskBuddy-Token"]).toBeUndefined();
  });

  it("fails on non-200 or missing ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(401, { ok: false })).mockResolvedValueOnce(json(200, {})));
    expect((await sendReport("https://h.example", "x", report)).ok).toBe(false);
    expect((await sendReport("https://h.example", "x", report)).ok).toBe(false);
  });

  it("ping parses {ok:true}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(200, { ok: true, name: "Claude Usage Hub", v: 1 })).mockResolvedValueOnce(json(200, "<html>")));
    expect(await ping("https://h.example", "t")).toEqual({ ok: true });
    expect((await ping("https://h.example", "t")).ok).toBe(false);
  });
});

import { fetchHubState } from "../src/sync/hub";
describe("fetchHubState", () => {
  it("GETs /api/state with Bearer and never throws", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { ok: true, devices: [] })).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(json(401, {}));
    vi.stubGlobal("fetch", f);
    expect(await fetchHubState("https://h.example/", "tok")).toMatchObject({ ok: true, devices: [] });
    expect(f.mock.calls[0][0]).toBe("https://h.example/api/state");
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(await fetchHubState("https://h.example", "tok")).toMatchObject({ ok: false, error: "boom" });
    expect(await fetchHubState("https://h.example", "tok")).toMatchObject({ ok: false, error: "HTTP 401 (check hub token)" });
  });
});
