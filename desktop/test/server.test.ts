import { createServer, request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/server";
import type { DesktopState } from "../src/shared/ipc";

const TOKEN = "test-token-not-real";
let tmp: string;
let hubSrv: Server;
let hubPort = 0;
let hubAuthSeen = "";
let srv: RunningServer;
let exited = false;
const fetchedAt = Date.now() - 1000;

function raw(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "um-srv-"));
  const dist = join(tmp, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html>ok</html>");
  hubSrv = createServer((req, res) => {
    hubAuthSeen = String(req.headers.authorization ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, devices: [], account: { fetchedAt, windows: [{ name: "five_hour", utilization: 40, resetsAt: new Date(Date.now() + 3600_000).toISOString() }, { name: "seven_day", utilization: 10 }] } }));
  });
  await new Promise<void>((r) => hubSrv.listen(0, "127.0.0.1", () => r()));
  hubPort = (hubSrv.address() as { port: number }).port;
  srv = await startServer({
    dataDir: join(tmp, "data"),
    projectsDir: join(tmp, "projects"),
    distDir: dist,
    hub: { url: `http://127.0.0.1:${hubPort}`, token: TOKEN },
    port: 0,
    credentialsPath: null,
    hubPollMs: 60_000,
    scanIntervalMs: 60_000,
    onExit: () => { exited = true; },
  });
  await srv.hubRefresh();
});

afterAll(async () => {
  await srv?.close();
  await new Promise<void>((r) => hubSrv.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("usage meter server", () => {
  it("serves index with the key and rejects a wrong or missing key", async () => {
    const ok = await raw(srv.port, `/u/${srv.key}/`);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("ok");
    expect((await raw(srv.port, `/u/wrong/api/state`)).status).toBe(403);
    expect((await raw(srv.port, `/api/state`)).status).toBe(404);
  });

  it("rejects foreign Host headers", async () => {
    expect((await raw(srv.port, `/u/${srv.key}/api/state`, { Host: "evil.example" })).status).toBe(403);
    expect((await raw(srv.port, `/u/${srv.key}/api/state`, { Host: `localhost:${srv.port}` })).status).toBe(200);
  });

  it("applies hub account usage and reports it", async () => {
    expect(hubAuthSeen).toBe(`Bearer ${TOKEN}`);
    const r = await raw(srv.port, `/u/${srv.key}/api/state`);
    const s = JSON.parse(r.body) as DesktopState;
    expect(s.auth.state).toBe("signed-in");
    expect(s.accountUsage?.fetchedAt).toBe(fetchedAt);
    expect(s.accountUsage?.windows.map((w) => w.name)).toEqual(["five_hour", "seven_day"]);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it("streams state over SSE", async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: srv.port, path: `/u/${srv.key}/api/events` }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.once("data", (c) => {
          resolve(String(c));
          r.destroy();
        });
      });
      r.on("error", () => {});
      r.end();
      setTimeout(() => reject(new Error("no sse")), 3000);
    });
    expect(first.startsWith("data: ")).toBe(true);
    expect((JSON.parse(first.slice(6)) as DesktopState).accountUsage).not.toBeNull();
    expect(srv.sseStatus().everConnected).toBe(true);
  });

  it("handles set-ui, sign-in hint and quit requests", async () => {
    const post = (body: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const data = JSON.stringify(body);
        const r = request({ host: "127.0.0.1", port: srv.port, path: `/u/${srv.key}/api/request`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        r.on("error", reject);
        r.end(data);
      });
    const ui = JSON.parse((await post({ type: "set-ui", ui: { collapsed: true } })).body) as { result: DesktopState };
    expect(ui.result.ui.collapsed).toBe(true);
    const si = JSON.parse((await post({ type: "sign-in" })).body) as { result: { hint: string } };
    expect(si.result.hint).toContain("Usage Hub");
    expect((await post({ type: "quit" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(exited).toBe(true);
  });
});
