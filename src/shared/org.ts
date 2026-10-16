import type { Plan } from "./types";

// Pure helpers for discovering the active claude.ai organization (no chrome.* / DOM access).

export const ORG_HINT_RE = /^[0-9a-f-]{36}$/i;

/** Extracts a UUID `lastActiveOrg` from a document.cookie string, or null. */
export function parseLastActiveOrg(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== "lastActiveOrg") continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    return ORG_HINT_RE.test(v) ? v : null;
  }
  return null;
}

/** Picks an org uuid from a GET /api/organizations response: the hint if present, else a chat-capable org, else the first. */
export function pickOrg(json: unknown, hint?: string | null): string | null {
  if (!Array.isArray(json)) return null;
  const orgs: { uuid: string; chat: boolean }[] = [];
  for (const o of json) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (typeof r.uuid !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(r.uuid)) continue;
    const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
    orgs.push({ uuid: r.uuid, chat: caps.includes("chat") });
  }
  if (!orgs.length) return null;
  if (hint) {
    const h = orgs.find((o) => o.uuid.toLowerCase() === hint.toLowerCase());
    if (h) return h.uuid;
  }
  return (orgs.find((o) => o.chat) ?? orgs[0]).uuid;
}

/**
 * Plan of the given org from a GET /api/organizations response (capabilities array):
 * claude_max -> max, claude_pro -> pro, raven/enterprise/team -> team, otherwise free.
 * null when the org (or its capabilities) cannot be found.
 */
export function planOfOrgs(json: unknown, orgId: string | null | undefined): Plan | null {
  if (!Array.isArray(json)) return null;
  const org = json.find(
    (o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && typeof (o as Record<string, unknown>).uuid === "string" &&
      (!orgId || ((o as Record<string, unknown>).uuid as string).toLowerCase() === orgId.toLowerCase()),
  );
  if (!org || !Array.isArray(org.capabilities)) return null;
  const caps = org.capabilities.filter((c): c is string => typeof c === "string");
  if (caps.includes("claude_max")) return "max";
  if (caps.includes("claude_pro")) return "pro";
  if (caps.some((c) => c === "raven" || c === "enterprise" || c === "team")) return "team";
  return "free";
}
