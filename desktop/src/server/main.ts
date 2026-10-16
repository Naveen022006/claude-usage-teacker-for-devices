// Entry point: start the server, open an Edge app-mode window, shut down when the window goes away.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, DEFAULT_PORT, defaultDirs, startServer } from "./server";

const argv = process.argv.slice(2);
const headless = argv.includes("--headless");
const parentIdx = argv.indexOf("--parent-pid");
const parentPid = parentIdx >= 0 ? Number(argv[parentIdx + 1]) : NaN;
const noWindow = headless || process.env.USAGE_METER_NO_WINDOW === "1";
const { dataDir, projectsDir } = defaultDirs();
const instanceFile = join(dataDir, "instance.json");

function edgePath(): string | null {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, "C:\\Program Files (x86)", "C:\\Program Files"];
  for (const r of roots) {
    if (!r) continue;
    const p = join(r, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

function openWindow(url: string): ChildProcess | null {
  if (noWindow) return null;
  const edge = edgePath();
  if (edge) {
    const args = [`--app=${url}`, "--window-size=340,520", `--user-data-dir=${join(dataDir, "edge-profile")}`, "--no-first-run", "--disable-features=Translate"];
    const child = spawn(edge, args, { stdio: "ignore" });
    child.on("error", () => console.log(`Could not start Edge. Open: ${url}`));
    return child;
  }
  console.log(`Edge not found. Open: ${url}`);
  spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  return null;
}

async function existingInstance(): Promise<string | null> {
  try {
    const inst = JSON.parse(readFileSync(instanceFile, "utf8")) as { port: number; key: string };
    const r = await fetch(`http://127.0.0.1:${inst.port}/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { app?: string };
    if (j.app === APP_NAME) return `http://127.0.0.1:${inst.port}/u/${inst.key}/`;
  } catch {
    /* none running */
  }
  return null;
}

async function main(): Promise<void> {
  const other = await existingInstance();
  if (other && headless) {
    console.log("Usage Meter Desktop is already running.");
    return;
  }
  if (other) {
    console.log("Usage Meter Desktop is already running; opening a new window.");
    openWindow(other);
    return;
  }
  let stopping = false;
  const srv = await startServer({
    dataDir,
    projectsDir,
    distDir: __dirname,
    port: Number(process.env.USAGE_METER_PORT) || DEFAULT_PORT,
    onExit: () => void stop(),
  });
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      rmSync(instanceFile, { force: true });
    } catch {
      /* ignore */
    }
    try {
      await srv.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
  try {
    writeFileSync(instanceFile, JSON.stringify({ port: srv.port, key: srv.key, pid: process.pid }));
  } catch {
    /* ignore */
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop());
  console.log(`Usage Meter Desktop running (local server on port ${srv.port}).`);

  // Don't tie our lifetime to the spawned msedge.exe: it hands the window to Edge's browser process and
  // exits immediately. The SSE connection is the real "window is open" signal.
  openWindow(srv.url);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") void stop(); // parent gone
      }
    }, 5000).unref();
  }
  if (!noWindow) {
    const startedAt = Date.now();
    setInterval(() => {
      const s = srv.sseStatus();
      if (s.everConnected && s.clients === 0 && s.idleSince !== null && Date.now() - s.idleSince > 30_000) void stop();
      else if (!s.everConnected && Date.now() - startedAt > 120_000) void stop(); // window never connected
    }, 5000).unref();
  }
}

main().catch((e) => {
  console.error("[usage-meter] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
