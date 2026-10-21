// Settings-page discovery: the SHAPE of JSON API responses (key names and value types only, never values).
// Pure: no chrome.* / DOM. Used to find how claude.ai lists signed-in devices without guessing endpoints.

import type { ApiShape, ApiShapeObservation } from "../shared/types";

const MAX_DEPTH = 3;
const MAX_KEYS = 40;
const MAX_KEY_LEN = 40;
const RING = 20;
const SESSION_KEY_RE = /created|updated|last_?(active|used|seen)|is_?current|device|user_?agent|platform|browser|location|current/i;

export function isSettingsPath(pathname: string): boolean {
  return typeof pathname === "string" && pathname.startsWith("/settings");
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" ? t : "undefined";
}

function valueShape(v: unknown, depth: number): string | ApiShape {
  if (Array.isArray(v)) {
    const label = `array(${v.length})`;
    if (depth >= MAX_DEPTH) return label;
    const out: ApiShape = { "(array)": label };
    if (v.length > 0) out["[0]"] = valueShape(v[0], depth + 1);
    return out;
  }
  if (typeof v === "object" && v !== null) {
    if (depth >= MAX_DEPTH) return "object";
    const out: ApiShape = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= MAX_KEYS) break;
      out[k.slice(0, MAX_KEY_LEN)] = valueShape((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return typeOf(v);
}

/** Key names → type names, recursing to depth 3. Arrays show their length and the FIRST element's shape only. */
export function shapeOf(json: unknown): ApiShape {
  try {
    const s = valueShape(json, 0);
    return typeof s === "string" ? { "(root)": s } : s;
  } catch {
    return { "(error)": "unreadable" };
  }
}

/** Hint only: an array whose element looks like a session/device record (>=2 matching key names). */
export function looksLikeSessionList(shape: ApiShape): boolean {
  const walk = (s: ApiShape): boolean => {
    const first = s["[0]"];
    if (first && typeof first === "object" && Object.keys(first).filter((k) => SESSION_KEY_RE.test(k)).length >= 2) return true;
    return Object.values(s).some((v) => typeof v === "object" && walk(v));
  };
  try {
    return walk(shape);
  } catch {
    return false;
  }
}

/** Newest-last ring of observations, deduped by method + path pattern (newest kept). */
export class ApiShapeRing {
  private items: ApiShapeObservation[] = [];

  add(o: ApiShapeObservation): void {
    this.items = this.items.filter((x) => !(x.method === o.method && x.pathPattern === o.pathPattern));
    this.items.push(o);
    if (this.items.length > RING) this.items.shift();
  }

  list(): ApiShapeObservation[] {
    return this.items.slice();
  }
}
