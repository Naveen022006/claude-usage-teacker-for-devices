// WARNING: this endpoint is UNDOCUMENTED and may change or vanish at any time.
// The response shape is unverified, so parsing is defensive and fails soft (null).

import type { AccountUsage, AccountWindow } from "../shared/types";

const ORG_RE = /^[A-Za-z0-9-]{1,64}$/;

export function parseAccountUsage(json: unknown, now = Date.now()): AccountUsage | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const windows: AccountWindow[] = [];
  for (const [key, v] of Object.entries(json)) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const u = o.utilization;
    if (typeof u !== "number" || !Number.isFinite(u)) continue;
    const r = o.resets_at ?? o.resetsAt;
    const w: AccountWindow = { name: key.slice(0, 64), utilization: Math.min(100, Math.max(0, u)) };
    if (typeof r === "string" && r.length <= 64) w.resetsAt = r;
    windows.push(w);
  }
  return windows.length ? { fetchedAt: now, windows } : null;
}

export async function fetchAccountUsage(orgId: string): Promise<AccountUsage | null> {
  if (!ORG_RE.test(orgId)) return null;
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, { credentials: "include" });
    if (!res.ok) {
      console.warn("[deskbuddy] usage endpoint HTTP", res.status);
      return null;
    }
    const parsed = parseAccountUsage(await res.json());
    if (!parsed) console.warn("[deskbuddy] unknown usage response shape");
    return parsed;
  } catch (e) {
    console.warn("[deskbuddy] usage fetch failed", e);
    return null;
  }
}
