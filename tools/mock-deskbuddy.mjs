#!/usr/bin/env node
// Zero-dependency mock of the DeskBuddy device. Contract: firmware/SPEC.md "HTTP API" + "Merge rules".
// Env: PORT (default 8787), DESKBUDDY_TOKEN (if set, required in X-DeskBuddy-Token).
import { createServer } from "node:http";
import { MAX_BODY, applyReport, mergedView, newState, validateReport } from "./mock-merge.mjs";

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.DESKBUDDY_TOKEN || "";
const FW = "mock-1";
const state = newState();
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENT[c]);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function send(res, code, body, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
const authed = (req) => !TOKEN || req.headers["x-deskbuddy-token"] === TOKEN;

function printTable() {
  const v = mergedView(state);
  console.log(`\n[${new Date().toTimeString().slice(0, 8)}] ${v.devices.length} device(s)`);
  for (const d of v.devices) {
    const w = d.windows.today;
    console.log(
      `  ${d.deviceName.padEnd(24)} ${d.source.padEnd(12)} ${d.fresh ? "fresh" : "stale"}  today ${String(w.messages).padStart(5)} msgs  in ${fmt(w.promptTokens).padStart(7)}  out ${fmt(w.outputTokens).padStart(7)}`,
    );
  }
  const t = v.totals.today;
  console.log(`  ${"TOTAL (fresh)".padEnd(24)} ${"".padEnd(12)} ${"".padEnd(5)}  today ${String(t.messages).padStart(5)} msgs  in ${fmt(t.promptTokens).padStart(7)}  out ${fmt(t.outputTokens).padStart(7)}`);
  const five = v.account?.windows.find((w) => w.name === "five_hour");
  if (five) console.log(`  account five_hour: ${five.utilization}%`);
}

function statusPage() {
  const v = mergedView(state);
  const rows = v.devices
    .map(
      (d) =>
        `<tr style="opacity:${d.fresh ? 1 : 0.5}"><td>${esc(d.deviceName)}</td><td>${esc(d.source)}</td><td>${d.fresh ? "fresh" : "stale"}</td><td>${d.windows.today.messages}</td><td>${esc(fmt(d.windows.today.promptTokens))}</td><td>${esc(fmt(d.windows.today.outputTokens))}</td></tr>`,
    )
    .join("");
  const t = v.totals.today;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>DeskBuddy mock</title>
<style>body{font:14px system-ui;margin:2rem}td,th{padding:.25rem .75rem;text-align:left}</style>
<h1>DeskBuddy mock (${esc(FW)})</h1>
<table><tr><th>Device</th><th>Source</th><th>State</th><th>Today msgs</th><th>Prompt tok</th><th>Output tok</th></tr>${rows}
<tr><th>Total (fresh)</th><th></th><th></th><th>${t.messages}</th><th>${esc(fmt(t.promptTokens))}</th><th>${esc(fmt(t.outputTokens))}</th></tr></table>`;
}

const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && path === "/") return send(res, 200, statusPage(), "text/html");
  if (path === "/api/ping" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    return send(res, 200, { ok: true, name: "DeskBuddy", fw: FW, devices: state.devices.size });
  }
  if (path === "/api/state" && req.method === "GET") return send(res, 200, mergedView(state));
  if (path === "/api/report" && req.method === "POST") {
    if (!authed(req)) {
      req.resume();
      return send(res, 401, { ok: false, error: "unauthorized" });
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, { ok: false, error: "payload too large" });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { ok: false, error: "invalid json" });
      }
      const r = validateReport(body);
      if (!r) return send(res, 400, { ok: false, error: "invalid report" });
      applyReport(state, r);
      printTable();
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, () => console.log(`mock DeskBuddy on http://127.0.0.1:${PORT}  token ${TOKEN ? "required" : "off"}`));
