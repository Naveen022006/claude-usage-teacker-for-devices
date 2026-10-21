// WARNING: this endpoint is UNDOCUMENTED and may change or vanish at any time.
// The response shape is unverified (and differs by plan), so parsing is defensive and fails soft (null).

import type { AccountUsage, AccountWindow, UsageBreakdown, UsageDiag } from "../shared/types";
import { toIso } from "../widget/helpers";

const ORG_RE = /^[A-Za-z0-9-]{1,64}$/;
const CONTAINER_KEYS = ["windows", "rate_limits", "rateLimits", "limits", "usage", "data"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function canonName(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s-]/g, "_");
  if (s === "5h" || s === "5_hour" || s === "five_hour" || s === "session") return "five_hour";
  if (s === "7d" || s === "7_day" || s === "seven_day" || s === "weekly" || s === "week") return "seven_day";
  return raw.trim();
}

function num(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function readWindow(name: string, o: Record<string, unknown>): { name: string; raw: number; resetsAt?: string } | null {
  const raw = num(o.utilization ?? o.used_percent ?? o.percent_used ?? o.percentage ?? o.percent);
  if (raw === null || !name) return null;
  const r = o.resets_at ?? o.resetsAt ?? o.reset_at ?? o.resetAt;
  const iso = typeof r === "string" && r.length <= 64 && !/^\d+$/.test(r.trim()) ? r : toIso(r);
  return { name: canonName(name).slice(0, 64), raw, ...(iso ? { resetsAt: iso } : {}) };
}

/**
 * Newer shape: `limits: [{ kind, percent, resets_at, scope? }]`, where kind is "session", "weekly_all" or
 * "weekly_scoped" (scope.model.display_name names the model). Read first so it wins over the older top-level
 * five_hour / seven_day fields. Returns whether any entry had a `kind`.
 */
function collectKindLimits(list: unknown, out: { name: string; raw: number; resetsAt?: string }[]): boolean {
  if (!Array.isArray(list)) return false;
  let sawKind = false;
  for (const it of list) {
    if (!isObj(it) || typeof it.kind !== "string") continue;
    sawKind = true;
    let name: string;
    if (it.kind === "weekly_all") name = "seven_day";
    else if (it.kind === "weekly_scoped") {
      const scope = isObj(it.scope) ? it.scope : null;
      const model = scope && isObj(scope.model) ? scope.model.display_name : null;
      const m = typeof model === "string" ? model.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32) : "";
      if (!m) {
        console.warn("[claude-usage] weekly_scoped limit without a model name");
        continue;
      }
      name = `seven_day_${m}`;
    } else name = it.kind;
    const w = readWindow(name, it);
    if (w) out.push(w);
  }
  return sawKind;
}

function collect(container: unknown, out: { name: string; raw: number; resetsAt?: string }[]): void {
  if (Array.isArray(container)) {
    for (const it of container) {
      if (!isObj(it)) continue;
      const n = it.window ?? it.name ?? it.type ?? it.id ?? it.key;
      if (typeof n !== "string") continue;
      const w = readWindow(n, it);
      if (w) out.push(w);
    }
  } else if (isObj(container)) {
    for (const [k, v] of Object.entries(container)) {
      if (isObj(v)) {
        const w = readWindow(k, v);
        if (w) out.push(w);
      }
    }
  }
}

/** Read `seven_day_breakdown` defensively; undefined when there are no valid rows. Never throws. */
export function parseBreakdown(v: unknown): UsageBreakdown | undefined {
  try {
    if (!isObj(v) || !Array.isArray(v.rows)) return undefined;
    const rows: UsageBreakdown["rows"] = [];
    for (const r of v.rows) {
      if (rows.length >= 12) break;
      if (!isObj(r) || typeof r.key !== "string" || r.key.length === 0 || r.key.length > 40) continue;
      const name = typeof r.display_name === "string" ? r.display_name.trim() : "";
      if (!name || name.length > 40) continue;
      if (typeof r.percent !== "number" || !Number.isFinite(r.percent) || r.percent < 0) continue;
      rows.push({ key: r.key, name, percent: Math.min(100, r.percent) });
    }
    if (!rows.length) return undefined;
    const str = (x: unknown): string | undefined => (typeof x === "string" && x.length <= 64 ? x : undefined);
    const asOf = str(v.as_of);
    const windowStartedAt = str(v.window_started_at);
    return { ...(asOf ? { asOf } : {}), ...(windowStartedAt ? { windowStartedAt } : {}), rows };
  } catch {
    return undefined;
  }
}

/** Never throws. Accepts utilization as 0–100 or 0–1 (all values <= 1 with a fractional one => fractions). */
export function parseAccountUsage(json: unknown, now = Date.now()): AccountUsage | null {
  try {
    if (typeof json !== "object" || json === null) return null;
    const found: { name: string; raw: number; resetsAt?: string }[] = [];
    const kindLimits = isObj(json) && collectKindLimits(json.limits, found);
    collect(json, found);
    if (isObj(json)) for (const k of CONTAINER_KEYS) if (k in json && !(k === "limits" && kindLimits)) collect(json[k], found);
    if (!found.length) return null;
    const fractions = found.every((f) => f.raw <= 1) && found.some((f) => f.raw > 0 && f.raw < 1);
    const seen = new Set<string>();
    const windows: AccountWindow[] = [];
    for (const f of found) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      const w: AccountWindow = { name: f.name, utilization: Math.min(100, Math.max(0, fractions ? f.raw * 100 : f.raw)) };
      if (f.resetsAt) w.resetsAt = f.resetsAt;
      windows.push(w);
    }
    const breakdown = isObj(json) ? parseBreakdown(json.seven_day_breakdown) : undefined;
    return { fetchedAt: now, windows, ...(breakdown ? { breakdown } : {}) };
  } catch {
    return null;
  }
}

/** Shape only (no values): top-level key -> typeof, and one level down key -> typeof. */
export function describeShape(json: unknown): Record<string, string | Record<string, string>> {
  const t = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v);
  const out: Record<string, string | Record<string, string>> = {};
  try {
    if (typeof json !== "object" || json === null) return { "(root)": t(json) };
    if (Array.isArray(json)) return { "(root)": t(json) };
    for (const [k, v] of Object.entries(json).slice(0, 40)) {
      const sub = Array.isArray(v) ? v[0] : v;
      if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
        const m: Record<string, string> = {};
        for (const [k2, v2] of Object.entries(sub).slice(0, 40)) {
          const key2 = k2.slice(0, 40);
          m[key2] = t(v2);
          const first = Array.isArray(v2) ? v2[0] : undefined;
          if (typeof first === "object" && first !== null && !Array.isArray(first)) {
            for (const [k3, v3] of Object.entries(first)) {
              if (Object.keys(m).length >= 40) break;
              m[`${key2}[0].${k3.slice(0, 40)}`] = t(v3);
            }
          }
        }
        out[k.slice(0, 40)] = Array.isArray(v) ? { "(array)": t(v), ...m } : m;
      } else out[k.slice(0, 40)] = t(v);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function fetchAccountUsage(orgId: string, onDiag?: (d: UsageDiag) => void): Promise<AccountUsage | null> {
  if (!ORG_RE.test(orgId)) return null;
  const at = Date.now();
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, { credentials: "include" });
    if (!res.ok) {
      console.warn("[claude-usage] usage endpoint HTTP", res.status);
      onDiag?.({ at, status: res.status, shape: {}, parsed: false });
      return null;
    }
    const json: unknown = await res.json();
    const parsed = parseAccountUsage(json);
    if (!parsed) console.warn("[claude-usage] unknown usage response shape");
    onDiag?.({ at, status: res.status, shape: describeShape(json), parsed: !!parsed });
    return parsed;
  } catch (e) {
    console.warn("[claude-usage] usage fetch failed", e);
    onDiag?.({ at, status: null, shape: {}, parsed: false });
    return null;
  }
}
