// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceRowsFor, devicesPanel, DEVICES_FOOTER, pickWindow } from "../src/widget/helpers";
import type { DeviceView, DeviceWindowView } from "../src/shared/deviceAttribution";

const win = (over: Partial<DeviceWindowView> = {}): DeviceWindowView => ({
  cycle: "2026-01-01T14:00:00Z",
  totalPts: 15,
  unattributedPts: 2,
  rows: [
    { key: "local", label: "Chrome (this browser)", pts: 9, share: 0.6, confidence: "high" },
    { key: "hub:d1", label: "Claude Desktop (Windows)", pts: 4, share: 4 / 15, confidence: "low" },
  ],
  ...over,
});
const view = (): DeviceView => ({
  five_hour: win(),
  seven_day: win({ totalPts: 6, unattributedPts: 0.01, rows: [{ key: "local", label: "Chrome (this browser)", pts: 6, share: 1, confidence: "high" }] }),
});

describe("deviceRowsFor", () => {
  it("rows with pts, share %, badge, then an Unattributed row", () => {
    const rows = deviceRowsFor(win());
    expect(rows.map((r) => [r.label, r.pts, r.share, r.badge])).toEqual([
      ["Chrome (this browser)", "9.0 pts", "60%", "High"],
      ["Claude Desktop (Windows)", "4.0 pts", "27%", "Low"],
      ["Unattributed", "2.0 pts", "13%", null],
    ]);
    expect(rows[0].bar).toBeCloseTo(60);
    expect(rows[1].title).toContain("several devices");
    expect(rows[0].title).toContain("only this device");
    expect(rows[2].unattributed).toBe(true);
  });
  it("hides Unattributed below 0.05 pts and survives a zero total", () => {
    expect(deviceRowsFor(win({ unattributedPts: 0.04 })).some((r) => r.unattributed)).toBe(false);
    expect(deviceRowsFor(win({ unattributedPts: 0.05 })).some((r) => r.unattributed)).toBe(true);
    expect(deviceRowsFor(win({ totalPts: 0, unattributedPts: 0, rows: [] }))).toEqual([]);
  });
});

describe("devicesPanel", () => {
  const acct = { windows: [{ name: "five_hour", utilization: 15, resetsAt: "2026-01-01T15:00:00Z" }] };
  it("sections for the windows present, reset time from the account usage", () => {
    const p = devicesPanel(view(), acct, "pro");
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.sections.map((s) => [s.name, s.heading, s.total])).toEqual([
      ["five_hour", "5-hour", "Total 15.0 pts"],
      ["seven_day", "Weekly", "Total 6.0 pts"],
    ]);
    expect(p.sections[0].resetsAt).toBe("2026-01-01T15:00:00Z");
    expect(p.sections[1].resetsAt).toBe("2026-01-01T14:00:00Z"); // falls back to the cycle
    expect(p.sections[1].rows).toHaveLength(1);
  });
  it("empty states", () => {
    const waiting = { kind: "empty", message: "Waiting for your plan usage reading…" };
    expect(devicesPanel({}, null, "pro")).toEqual(waiting);
    expect(devicesPanel(undefined, null, null)).toEqual(waiting);
    expect(devicesPanel({}, null, "free")).toEqual({ kind: "empty", message: "Per-device usage needs a Pro/Max plan usage reading." });
  });
  it("the devices tab does not break pickWindow", () => {
    const w = { messages: 7, promptTokens: 0, outputTokens: 0, byModel: {} };
    expect(pickWindow({ today: w, last5h: w, last7d: w }, "devices").messages).toBe(7);
  });
});

// ---- widget rendering (sidebar + floating) ----

const SIDEBAR = `<div class="side"><nav aria-label="Sidebar"><div class="rows">
  <div class="r"><a href="/new"><span>New chat</span></a></div>
  <div class="r"><a href="/projects"><span>Projects</span></a></div>
  <div class="r"><a href="/artifacts"><span>Artifacts</span></a></div>
  <div class="r"><a href="/code"><span>Code</span></a></div>
  <div class="r" id="cust"><div><a href="/customize"><span>Customize</span></a></div></div>
</div><div class="sect"><h2>Recents</h2><a href="/chat/1">One</a></div></nav></div>`;

const state = (devices: DeviceView, plan = "pro") => {
  const now = Date.now();
  const w = { messages: 0, promptTokens: 0, outputTokens: 0, byModel: {} };
  return {
    device: { deviceId: "me", deviceName: "Chrome" },
    aggregates: { today: w, last5h: w, last7d: w },
    accountUsage: {
      fetchedAt: now,
      windows: [
        { name: "five_hour", utilization: 15, resetsAt: new Date(now + 3600_000).toISOString() },
        { name: "seven_day", utilization: 6, resetsAt: new Date(now + 86400_000).toISOString() },
      ],
    },
    attribution: {},
    devices,
    plan,
    limitHint: null,
    syncState: { lastOkAt: null, lastAttemptAt: null, lastError: null, queue: 0 },
    showWidget: true,
    codeDeviceIds: [],
    hub: { configured: false, ok: false, fetchedAt: 0, devices: [] },
    now,
    captureDiag: null,
    swDiag: { eventsReceived: 0, eventsRejected: 0, lastRejectReason: null, eventsStored: 0 },
  };
};

let shadow: ShadowRoot | null = null;
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

async function boot(devices: DeviceView, opts: { sidebar: boolean; plan?: string }) {
  document.body.innerHTML = opts.sidebar ? SIDEBAR : "<p>no sidebar</p>";
  (window as unknown as { __claudeUsagePath: string }).__claudeUsagePath = "/chat/abc";
  const real = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    shadow = real.call(this, init);
    return shadow;
  });
  if (opts.sidebar) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 280, height: 36, left: 0, right: 280, top: 0, bottom: 36, x: 0, y: 0, toJSON() {} } as DOMRect);
  }
  const data = state(devices, opts.plan);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: "t", sendMessage: () => Promise.resolve({ ok: true, data }), onMessage: { addListener() {}, removeListener() {} } },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {}, removeListener() {} } },
  };
  vi.resetModules();
  await import("../src/widget/widget");
  await flush();
}

const q = (sel: string) => shadow!.querySelector(sel) as HTMLElement | null;
const text = () => shadow!.textContent ?? "";

describe("Devices view in the widget", () => {
  beforeEach(() => {
    shadow = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("sidebar: Devices tab shows rows, badges, unattributed, totals and footer", async () => {
    await boot(view(), { sidebar: true });
    expect(shadow).not.toBeNull();
    expect(q(".sb")).not.toBeNull();
    q('[data-fk="sb-win-devices"]')!.click();
    await flush();
    const t = text();
    expect(t).toContain("5-hour");
    expect(t).toContain("Weekly");
    expect(t).toContain("Chrome (this browser)");
    expect(t).toContain("Claude Desktop (Windows)");
    expect(t).toContain("9.0 pts");
    expect(t).toContain("Unattributed");
    expect(t).toContain("Total 15.0 pts");
    expect(t).toContain(DEVICES_FOOTER);
    const badges = Array.from(shadow!.querySelectorAll(".dev-badge")).map((b) => b.textContent);
    expect(badges).toEqual(["High", "Low", "High"]);
    expect(q(".dev-badge.low")!.getAttribute("title")).toContain("several devices");
    expect(shadow!.querySelectorAll(".sb-row.dev")).toHaveLength(4); // 3 in 5-hour, 1 in weekly (unattributed hidden)
  });

  it("sidebar: empty state when there are no device windows yet", async () => {
    await boot({}, { sidebar: true });
    q('[data-fk="sb-win-devices"]')!.click();
    await flush();
    expect(text()).toContain("Waiting for your plan usage reading…");
    expect(shadow!.querySelectorAll(".dev-badge")).toHaveLength(0);
  });

  it("floating panel: Devices tab renders the same rows", async () => {
    await boot(view(), { sidebar: false });
    q(".pill")!.click();
    await flush();
    q("#tab-devices")!.click();
    await flush();
    const t = text();
    expect(t).toContain("Chrome (this browser)");
    expect(t).toContain("9.0 pts · 60%");
    expect(t).toContain("Unattributed");
    expect(t).toContain(DEVICES_FOOTER);
    expect(shadow!.querySelectorAll(".dev-badge").length).toBe(3);
    q("#tab-session")!.click(); // the other tabs still render model cards
    await flush();
    expect(shadow!.querySelectorAll(".card-head").length).toBeGreaterThan(0);
  });
});
