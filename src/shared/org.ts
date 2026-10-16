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
