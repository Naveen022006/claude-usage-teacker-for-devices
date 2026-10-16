import type { CapturedEvent, LimitHint } from "./types";
import { NS, type PageMessage, type WidgetRequest } from "./messages";

const STATUSES = ["ok", "error", "aborted"];
const KINDS = ["new", "retry"];
import { ORG_HINT_RE } from "./org";
const ORG_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_NUM = 1e15; // generous cap; keeps ts and char counts sane

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= MAX_NUM;
const str = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length >= 1 && x.length <= max;

export function validateCapturedEvent(x: unknown): CapturedEvent | null {
  if (!isObj(x)) return null;
  const { id, ts, model, promptChars, outputChars, thinkingChars, status, kind } = x;
  if (!str(id, 200) || !str(model, 100)) return null;
  if (!num(ts) || !num(promptChars) || !num(outputChars) || !num(thinkingChars)) return null;
  if (typeof status !== "string" || !STATUSES.includes(status)) return null;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  return { id, ts, model, promptChars, outputChars, thinkingChars, status, kind } as CapturedEvent;
}

function validateHint(x: unknown): LimitHint | null {
  if (!isObj(x) || !num(x.ts) || !isObj(x.fields)) return null;
  const entries = Object.entries(x.fields);
  if (entries.length > 32) return null;
  const fields: LimitHint["fields"] = {};
  for (const [k, v] of entries) {
    if (k.length > 64) return null;
    if (typeof v === "string") {
      if (v.length > 64) return null;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return null;
    } else if (typeof v !== "boolean") return null;
    fields[k] = v;
  }
  return { ts: x.ts, fields };
}

export function validatePageMessage(x: unknown): PageMessage | null {
  if (!isObj(x) || x.ns !== NS) return null;
  switch (x.type) {
    case "usage-event": {
      const payload = validateCapturedEvent(x.payload);
      return payload && { ns: NS, type: "usage-event", payload };
    }
    case "org-seen": {
      const p = x.payload;
      if (!isObj(p) || typeof p.orgId !== "string" || !ORG_RE.test(p.orgId)) return null;
      return { ns: NS, type: "org-seen", payload: { orgId: p.orgId } };
    }
    case "limit-hint": {
      const payload = validateHint(x.payload);
      return payload && { ns: NS, type: "limit-hint", payload };
    }
    default:
      return null;
  }
}

/** Settings.codeDeviceIds: array of non-empty strings (<=128 chars), deduped, max 20. null if not an array. */
export function sanitizeDeviceIds(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const v of x) {
    if (typeof v === "string" && v.length >= 1 && v.length <= 128 && !out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/** Validates the two widget request types (get-widget-state / open-options). They carry no data fields. */
export function validateWidgetRequest(x: unknown): WidgetRequest | null {
  if (!isObj(x) || x.ns !== NS) return null;
  if (x.type === "get-widget-state") {
    const orgHint = typeof x.orgHint === "string" && ORG_HINT_RE.test(x.orgHint) ? x.orgHint : undefined;
    return orgHint ? { ns: NS, type: "get-widget-state", orgHint } : { ns: NS, type: "get-widget-state" };
  }
  if (x.type === "open-options") return { ns: NS, type: "open-options" };
  return null;
}
