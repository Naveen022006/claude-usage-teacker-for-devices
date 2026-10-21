import { describe, expect, it } from "vitest";
import { RETENTION_MS, shouldAppend } from "../src/history";
import { nextBackoffMs, orgHash } from "../src/sync/backoff";
import type { AccountUsage, AccountWindow } from "../src/shared/types";

const NOW = 1_700_000_000_000;
const w5: AccountWindow = { name: "five_hour", utilization: 10, resetsAt: "2026-01-01T05:00:00Z" };
const w7: AccountWindow = { name: "seven_day", utilization: 40, resetsAt: "2026-01-07T00:00:00Z" };
const prev = { ts: NOW - 60_000, windows: [w5, w7] };
const usage = (windows: AccountWindow[]): AccountUsage => ({ fetchedAt: NOW, windows });

describe("shouldAppend", () => {
  it("appends the first reading", () => expect(shouldAppend(null, usage([w5]), NOW)).toBe(true));
  it("skips an unchanged reading", () => expect(shouldAppend(prev, usage([{ ...w7 }, { ...w5 }]), NOW)).toBe(false));
  it("appends when utilization changed", () => expect(shouldAppend(prev, usage([{ ...w5, utilization: 11 }, w7]), NOW)).toBe(true));
  it("appends when resetsAt changed", () => expect(shouldAppend(prev, usage([w5, { ...w7, resetsAt: "2026-01-08T00:00:00Z" }]), NOW)).toBe(true));
  it("appends when a window was added or removed", () => {
    expect(shouldAppend(prev, usage([w5, w7, { name: "seven_day_opus", utilization: 1 }]), NOW)).toBe(true);
    expect(shouldAppend(prev, usage([w5]), NOW)).toBe(true);
  });
  it("appends a heartbeat after one hour", () => {
    const old = { ts: NOW - 3600_000, windows: [w5, w7] };
    expect(shouldAppend(old, usage([w5, w7]), NOW)).toBe(true);
    expect(shouldAppend({ ts: NOW - 3599_000, windows: [w5, w7] }, usage([w5, w7]), NOW)).toBe(false);
  });
});

it("retains 90 days", () => expect(RETENTION_MS).toBe(90 * 24 * 3600_000));

describe("nextBackoffMs", () => {
  it("steps 2, 4, 8, 15 minutes and caps", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(nextBackoffMs).map((ms) => ms / 60_000)).toEqual([0, 2, 4, 8, 15, 15, 15]);
  });
});

describe("orgHash", () => {
  it("is 32 hex chars, stable, and matches the tray's org id pattern", async () => {
    const h = await orgHash("0b1c-org-id");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(await orgHash("0b1c-org-id"));
    expect(h).not.toBe(await orgHash("other"));
  });
  it("keeps null as null", async () => expect(await orgHash(null)).toBeNull());
});
