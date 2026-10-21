// WARNING: this endpoint is UNDOCUMENTED and may change or vanish at any time.
// Parses claude.ai's "Active sessions" list. Keeps ONLY a coarse device label and timestamps: never the session
// uuid, location, expiry or raw user agent. Fails soft (null / skipped entries), never throws.

export const SESSIONS_PATH = "/api/auth/sessions/list-active";

export interface ParsedSession {
  label: string;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
}

const MAX_ENTRIES = 50;
const MAX_PIECE = 40;
const MAX_LABEL = 80;
const MAX_UA_KEYS = 30;

const BROWSER_KEYS = [/^browser_family$/i, /^(browser|browser_name)$/i, /^(client)$/i, /^(app|app_name|application)$/i, /^(name|product)$/i];
const OS_KEYS = [/^os_family$/i, /^(os|os_name|platform|operating_system|system)$/i];
const PLACEHOLDER = new Set(["other", "unknown", ""]);
const WEB_SLUGS = new Set(["web", "claude-ai", "claude_ai", "webapp"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function clean(s: string): string | null {
  const t = s.trim();
  return PLACEHOLDER.has(t.toLowerCase()) ? null : t;
}

function strOf(v: unknown): string | null {
  if (typeof v === "string") return clean(v);
  if (isObj(v) && typeof v.name === "string") return clean(v.name);
  return null;
}

/** Native-app name from application_slug, or null for web / unknown slugs. */
function nativeApp(slug: unknown): { name: string; ios: boolean; android: boolean } | null {
  if (typeof slug !== "string") return null;
  const s = slug.trim().toLowerCase().slice(0, MAX_PIECE);
  if (!s || WEB_SLUGS.has(s)) return null;
  if (!/(desktop|ios|android|mobile|app)/.test(s)) return null;
  const name = s.includes("desktop") ? "Claude Desktop" : "Claude";
  return { name, ios: /(^|[-_\s])ios($|[-_\s])/.test(s), android: s.includes("android") };
}

function pick(ua: Record<string, unknown>, res: RegExp[]): string | null {
  for (const re of res) {
    for (const [k, v] of Object.entries(ua)) {
      if (!re.test(k)) continue;
      const s = strOf(v);
      if (s) return s.slice(0, MAX_PIECE);
    }
  }
  return null;
}

function fromSlug(slug: unknown): string | null {
  if (typeof slug !== "string") return null;
  const words = slug.trim().slice(0, MAX_PIECE).split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return null;
  const joined = words.join(" ").toLowerCase();
  if (joined === "web") return "Browser";
  if (joined === "ios") return "Claude (iOS)";
  if (joined === "android") return "Claude (Android)";
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function makeLabel(ua: unknown, slug: unknown): string {
  let label: string | null = null;
  const app = nativeApp(slug);
  const o = isObj(ua) ? pick(ua, OS_KEYS) : null;
  if (app) {
    const os = o ?? (app.ios ? "iOS" : app.android ? "Android" : null);
    label = os ? `${app.name} (${os})` : app.name;
  } else if (isObj(ua)) {
    const b = pick(ua, BROWSER_KEYS);
    if (b && o) label = `${b} (${o})`;
    else label = b ?? o;
  }
  return (label ?? fromSlug(slug) ?? "Unknown device").slice(0, MAX_LABEL);
}

const validDate = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));

export function parseSessions(json: unknown): { sessions: ParsedSession[]; hasMore: boolean; uaKeys: string[] } | null {
  try {
    if (!isObj(json) || !Array.isArray(json.data)) return null;
    const sessions: ParsedSession[] = [];
    const keys = new Set<string>();
    for (const e of json.data) {
      if (sessions.length >= MAX_ENTRIES) break;
      if (!isObj(e)) continue;
      if (isObj(e.user_agent)) for (const k of Object.keys(e.user_agent)) keys.add(k.slice(0, MAX_PIECE));
      if (!validDate(e.created_at) || !validDate(e.updated_at)) {
        console.warn("[claude-usage] skipping malformed session entry");
        continue;
      }
      const cur = e.is_current;
      sessions.push({
        label: makeLabel(e.user_agent, e.application_slug),
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        isCurrent: cur === true || cur === "true" || cur === 1,
      });
    }
    const pg = isObj(json.pagination) ? json.pagination : null;
    return { sessions, hasMore: pg?.has_more === true, uaKeys: [...keys].sort().slice(0, MAX_UA_KEYS) };
  } catch {
    return null;
  }
}

/** Stable, non-reversible id for a session: salted hash of label + created time (no uuid is ever used). */
export async function sessionKey(salt: string, s: ParsedSession): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${s.label}|${s.createdAt}`));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "session:" + hex.slice(0, 24);
}
