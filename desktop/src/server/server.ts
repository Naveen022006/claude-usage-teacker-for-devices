// Local server for Usage Meter Desktop. Runs the engine in plain Node (signed node.exe) and serves the
// renderer to a Microsoft Edge app-mode window (Smart App Control blocks unsigned Electron binaries).
// Binds 127.0.0.1 only; a random per-run key in the URL path + Host check keep other local pages out.
// Never logs the hub token. Never reads message content.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { AccountUsage, AccountWindow, Plan } from "../../../src/shared/types";
import { normalizeBase } from "../../../src/sync/hub";
import type { DesktopRequest, DesktopState } from "../shared/ipc";
import { createEngine, type Engine } from "../main/engine";
import { createAccountSource, NOTE_REFRESH, NOTE_TRAY_SIGN_IN, type RefreshSpawn } from "./accountUsage";
import { buildTrayState } from "./trayState";
import type { TrayState } from "../shared/tray";
import { loadConfig } from "../../../daemon/src/config";

export const APP_NAME = "usage-meter-desktop";
export const DEFAULT_PORT = 47823;
const POLL_MS = 3 * 60_000;
const BACKOFF_STEPS_MS = [2, 4, 8, 15].map((m) => m * 60_000);
const SSE_KEEPALIVE_MS = 25_000;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
const STATIC = new Set(["renderer.js", "styles.css", "icon.png"]);

export interface HubConf {
  url: string;
  token: string;
}

export interface ServerOpts {
  dataDir: string;
  projectsDir: string;
  /** Static files (index.html, renderer.js, ...). */
  distDir: string;
  /** Hub credentials; omit/undefined = load from the daemon config; null = none. */
  hub?: HubConf | null;
  port?: number;
  hubPollMs?: number;
  /** Claude Code credentials file; undefined = default location; null = none. Read only. */
  credentialsPath?: string | null;
  /** Injectable fetch for the account usage API (tests). */
  accountFetch?: typeof fetch;
  /** Isolated tray-owned CLAUDE_CONFIG_DIR; undefined = <dataDir>/claude-auth; null = disabled. */
  trayAuthDir?: string | null;
  /** Injectable runner for the silent `claude auth status` token refresh (tests). */
  accountSpawn?: RefreshSpawn;
  accountPollMs?: number;
  /** Injectable clock for backoff/staleness (tests). */
  now?: () => number;
  scanIntervalMs?: number;
  /** Called when the server wants to end the process (quit request). */
  onExit?: () => void;
}

export interface RunningServer {
  port: number;
  key: string;
  url: string;
  engine: Engine;
  close(): Promise<void>;
  sseStatus(): { clients: number; everConnected: boolean; idleSince: number | null };
  hubRefresh(): Promise<void>;
  limitsRefresh(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Defensive parse of the hub's `account` field. */
export function parseAccount(a: unknown): AccountUsage | null {
  if (!isObj(a) || !Array.isArray(a.windows)) return null;
  const fetchedAt = typeof a.fetchedAt === "number" && Number.isFinite(a.fetchedAt) ? a.fetchedAt : null;
  if (fetchedAt === null) return null;
  const windows: AccountWindow[] = [];
  for (const w of a.windows.slice(0, 16)) {
    if (!isObj(w) || typeof w.name !== "string" || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    windows.push({ name: w.name.slice(0, 64), utilization: w.utilization, ...(typeof w.resetsAt === "string" ? { resetsAt: w.resetsAt.slice(0, 64) } : {}) } as AccountWindow);
  }
  return { fetchedAt, windows };
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function loadHubConf(): Promise<HubConf | null> {
  try {
    const c = await loadConfig(undefined, () => {});
    const url = normalizeBase(c.hubUrl || "");
    return url && c.hubToken ? { url, token: c.hubToken } : null;
  } catch {
    return null;
  }
}

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  mkdirSync(opts.dataDir, { recursive: true });
  const hub: HubConf | null = opts.hub === undefined ? await loadHubConf() : opts.hub ? { url: normalizeBase(opts.hub.url), token: opts.hub.token } : null;
  const key = randomBytes(18).toString("base64url");
  const uiFile = join(opts.dataDir, "ui.json");
  const ui = { alwaysOnTop: true, collapsed: false };
  try {
    const j = JSON.parse(readFileSync(uiFile, "utf8"));
    if (typeof j.collapsed === "boolean") ui.collapsed = j.collapsed;
    if (typeof j.alwaysOnTop === "boolean") ui.alwaysOnTop = j.alwaysOnTop;
  } catch {
    /* first run */
  }

  const engine = createEngine({ dataDir: opts.dataDir, projectsDir: opts.projectsDir, scanIntervalMs: opts.scanIntervalMs });
  let accountUsage: AccountUsage | null = null;
  let hubError: string | undefined;
  let lastApplied = 0;
  let hubBusy: Promise<void> | null = null;
  let plan: Plan | null = null;
  let limitsSource: TrayState["limitsSource"] = null;
  let limitsNote: string | null = null;
  const account = createAccountSource({
    path: opts.credentialsPath === null ? join(opts.dataDir, "no-credentials.json") : opts.credentialsPath,
    trayDir: opts.trayAuthDir === undefined ? join(opts.dataDir, "claude-auth") : opts.trayAuthDir,
    spawnFn: opts.accountSpawn,
    fetchFn: opts.accountFetch,
    now: opts.now,
  });
  let fingerprint: string | null = null; // identity hash of the account the current readings/ledger belong to
  let credStamp = account.stamp();
  let accountBusy: Promise<void> | null = null;
  const clock = opts.now ?? Date.now;
  let backoffUntil: number | null = null;
  let failures = 0;
  let lastLog = "";
  const logState = (s: string) => {
    if (s === lastLog) return;
    lastLog = s;
    console.log(`[usage-meter] account usage: ${s}`);
  };
  const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

  // Last good reading survives restarts (never contains tokens).
  const accountFile = join(opts.dataDir, "account.json");
  try {
    const j = JSON.parse(readFileSync(accountFile, "utf8")) as Record<string, unknown>;
    const u = parseAccount(j.usage);
    if (u) {
      accountUsage = u;
      limitsSource = "account";
      if (typeof j.plan === "string") plan = j.plan as Plan;
      if (typeof j.fp === "string") fingerprint = j.fp;
    }
  } catch {
    /* none yet */
  }
  function saveAccount(u: AccountUsage, p: Plan | null): void {
    // fp = hash of the account identity (no tokens)
    try {
      const tmpFile = `${accountFile}.tmp`;
      writeFileSync(tmpFile, JSON.stringify({ usage: u, plan: p, fp: fingerprint }));
      renameSync(tmpFile, accountFile);
    } catch {
      /* ignore */
    }
  }

  function buildState(): DesktopState {
    const e = engine.snapshot();
    return {
      now: Date.now(),
      auth: hub || limitsSource === "account" ? { state: "signed-in", ...(hubError && limitsSource !== "account" ? { error: hubError } : {}) } : { state: "signed-out" },
      plan,
      accountUsage,
      attribution: e.attribution,
      local: e.local,
      tokens5hByModel: e.tokens5hByModel,
      scan: e.scan,
      ui: { ...ui },
    };
  }

  // ---- SSE ----
  const clients = new Set<ServerResponse>();
  let everConnected = false;
  let idleSince: number | null = null;
  let pushTimer: NodeJS.Timeout | null = null;
  const writeState = (res: ServerResponse) => {
    try {
      res.write(`data: ${JSON.stringify(buildState())}\n\n`);
    } catch {
      /* closed */
    }
  };
  function pushSoon(): void {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const c of clients) writeState(c);
    }, 200);
  }
  const keepalive = setInterval(() => {
    for (const c of clients) {
      try {
        c.write(": keepalive\n\n");
      } catch {
        /* closed */
      }
    }
  }, SSE_KEEPALIVE_MS);
  keepalive.unref();

  // ---- hub ----
  async function hubFetch(): Promise<void> {
    if (!hub) return;
    try {
      const res = await fetch(`${hub.url}/api/state`, { headers: { Authorization: `Bearer ${hub.token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) {
        hubError = res.status === 401 ? "Hub rejected the token (HTTP 401)" : `Hub error (HTTP ${res.status})`;
      } else {
        const body = (await res.json().catch(() => null)) as unknown;
        const acct = isObj(body) ? parseAccount(body.account) : null;
        hubError = undefined;
        if (acct && acct.fetchedAt > lastApplied) {
          lastApplied = acct.fetchedAt;
          accountUsage = acct;
          limitsSource = "hub";
          limitsNote = null;
          engine.applyAccountUsage(acct, acct.fetchedAt);
        }
      }
    } catch (e) {
      hubError = e instanceof Error && e.name === "TimeoutError" ? "Hub timed out" : "Hub unreachable";
    }
    pushSoon();
  }
  function hubRefresh(): Promise<void> {
    if (!hubBusy) hubBusy = hubFetch().finally(() => { hubBusy = null; });
    return hubBusy;
  }
  /** Readings now come from another account: the old ledger/readings no longer apply. */
  function noteAccount(fp: string | null | undefined): void {
    if (!fp) return;
    if (fingerprint !== null && fingerprint !== fp) {
      engine.resetAttribution();
      accountUsage = null;
      failures = 0;
      backoffUntil = null;
      logState("account changed, attribution reset");
    }
    fingerprint = fp;
  }
  async function accountFetchOnce(): Promise<void> {
    const r = await account.poll();
    credStamp = account.stamp();
    if (r.kind === "ok" || r.kind === "error") noteAccount(r.fingerprint);
    if (r.kind === "ok") {
      accountUsage = r.usage;
      if (r.plan) plan = r.plan;
      limitsSource = "account";
      limitsNote = null;
      failures = 0;
      backoffUntil = null;
      saveAccount(r.usage, r.plan ?? plan);
      logState("ok");
      engine.applyAccountUsage(r.usage, r.usage.fetchedAt);
    } else if (r.kind === "error") {
      if (r.plan) plan = r.plan;
      limitsNote = r.note;
      if (limitsSource === null && !accountUsage) limitsSource = "account";
      if (r.note === NOTE_REFRESH || r.note === NOTE_TRAY_SIGN_IN) {
        backoffUntil = null;
        logState("sign-in needs refresh");
      } else {
        const wait = r.retryAfterMs !== undefined ? r.retryAfterMs : BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)];
        failures++;
        backoffUntil = clock() + wait;
        logState(`${r.httpStatus === 429 ? "rate-limited" : r.httpStatus ? `HTTP ${r.httpStatus}` : "unreachable"}, retrying after ${hhmm(backoffUntil)}`);
      }
    } else if (hub) {
      limitsNote = null;
      await hubFetch();
    } else {
      limitsNote = r.note;
    }
    pushSoon();
  }
  /** Account (Claude Code sign-in) when available; Usage Hub only as fallback when there is no credentials file. */
  function limitsRefresh(): Promise<void> {
    if (backoffUntil !== null && clock() < backoffUntil) return Promise.resolve();
    if (!accountBusy) accountBusy = accountFetchOnce().catch(() => {}).finally(() => { accountBusy = null; });
    return accountBusy;
  }
  const burst: NodeJS.Timeout[] = [];
  const offReplies = engine.onReplies(() => {
    for (const ms of [4000, 20000]) {
      const t = setTimeout(() => void limitsRefresh(), ms);
      t.unref();
      burst.push(t);
    }
  });
  const offChange = engine.onChange(pushSoon);
  const hubTimer = setInterval(() => void limitsRefresh(), opts.accountPollMs ?? opts.hubPollMs ?? POLL_MS);
  hubTimer.unref();

  // ---- http ----
  let port = 0;
  const hostOk = (req: IncomingMessage) => {
    const h = (req.headers.host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const send = (res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v), "application/json");

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let n = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > 16_384) {
          reject(new Error("too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      req.on("error", reject);
    });
  }

  let saveTimer: NodeJS.Timeout | null = null;
  function savePrefs(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        writeFileSync(uiFile, JSON.stringify(ui));
      } catch {
        /* ignore */
      }
    }, 300);
  }

  async function handleRequest(req: DesktopRequest): Promise<unknown> {
    switch (req?.type) {
      case "get-state":
        return buildState();
      case "auth-status": {
        const a = account.inspect();
        return { accountKind: a.accountKind, plan: a.plan, signedIn: a.accountKind === "tray" };
      }
      case "refresh":
        // Sign-in changed (credentials file written/removed): don't wait out a backoff meant for the old sign-in.
        if (account.stamp() !== credStamp) {
          backoffUntil = null;
          failures = 0;
        }
        await Promise.allSettled([engine.refreshNow(), limitsRefresh()]);
        return buildState();
      case "set-ui": {
        const u = req.ui ?? {};
        if (typeof u.collapsed === "boolean") ui.collapsed = u.collapsed;
        if (typeof u.alwaysOnTop === "boolean") ui.alwaysOnTop = u.alwaysOnTop;
        savePrefs();
        pushSoon();
        return buildState();
      }
      case "reset-attribution":
        engine.resetAttribution();
        pushSoon();
        return buildState();
      case "sign-in":
        return { hint: "Set your Usage Hub in the Chrome extension / daemon config" };
      case "sign-out":
        return null;
      case "quit":
        setTimeout(() => opts.onExit?.(), 100);
        return null;
      default:
        return null;
    }
  }

  const prefix = (): string => `/u/${key}/`;
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (!hostOk(req)) return send(res, 403, "forbidden");
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (u.pathname === "/health" && req.method === "GET") return json(res, 200, { app: APP_NAME });
        if (!u.pathname.startsWith("/u/")) return send(res, 404, "not found");
        const k = u.pathname.split("/")[2] ?? "";
        if (!safeEq(k, key)) return send(res, 403, "forbidden");
        const rest = u.pathname.slice(prefix().length);
        if (req.method === "GET" && (rest === "" || rest === "index.html" || STATIC.has(rest))) {
          const name = rest === "" ? "index.html" : rest;
          const f = join(opts.distDir, name);
          if (!existsSync(f)) return send(res, 404, "not built");
          res.writeHead(200, { "Content-Type": MIME[extname(name)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          return void res.end(readFileSync(f));
        }
        if (rest === "api/state" && req.method === "GET") return json(res, 200, buildState());
        if (rest === "api/tray" && req.method === "GET") {
          const e = engine.snapshot();
          const ai = account.inspect();
          return json(res, 200, buildTrayState({ now: clock(), backoffUntil, plan: ai.plan ?? plan, accountKind: limitsSource === "hub" ? null : ai.accountKind, limitsSource, limitsNote, accountUsage, attribution: e.attribution, tokensNew5hByModel: e.tokensNew5hByModel }));
        }
        if (rest === "api/events" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
          clients.add(res);
          everConnected = true;
          idleSince = null;
          res.on("close", () => {
            clients.delete(res);
            if (!clients.size) idleSince = Date.now();
          });
          return writeState(res);
        }
        if (rest === "api/request" && req.method === "POST") {
          let body: DesktopRequest;
          try {
            body = JSON.parse(await readBody(req)) as DesktopRequest;
          } catch {
            return json(res, 400, { error: "bad request" });
          }
          return json(res, 200, { result: await handleRequest(body) });
        }
        return send(res, 404, "not found");
      } catch (e) {
        console.warn("[usage-meter] request failed:", e instanceof Error ? e.message : String(e));
        if (!res.headersSent) send(res, 500, "error");
        else res.end();
      }
    })();
  });

  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      server.once("error", onErr);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", onErr);
        resolve();
      });
    });
  try {
    await listen(opts.port ?? DEFAULT_PORT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    await listen(0);
  }
  port = (server.address() as { port: number }).port;

  engine.start();
  void limitsRefresh();

  return {
    port,
    key,
    url: `http://127.0.0.1:${port}${prefix()}`,
    engine,
    hubRefresh,
    limitsRefresh,
    sseStatus: () => ({ clients: clients.size, everConnected, idleSince }),
    async close() {
      clearInterval(keepalive);
      clearInterval(hubTimer);
      if (pushTimer) clearTimeout(pushTimer);
      for (const t of burst) clearTimeout(t);
      if (saveTimer) {
        clearTimeout(saveTimer);
        try {
          writeFileSync(uiFile, JSON.stringify(ui));
        } catch {
          /* ignore */
        }
      }
      offReplies();
      offChange();
      engine.stop();
      for (const c of clients) c.end();
      clients.clear();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export function defaultDirs(): { dataDir: string; projectsDir: string } {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const projectsDir = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects");
  return { dataDir: join(appData, "UsageMeterDesktop"), projectsDir };
}
