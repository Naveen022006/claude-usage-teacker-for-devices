import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "hub_session";
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Timing-safe string comparison (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkToken(candidate: string | null | undefined, token = process.env.HUB_TOKEN): boolean {
  if (!candidate || !token) return false;
  return safeEqual(candidate, token);
}

export function bearerOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

const mac = (secret: string, exp: string) => createHmac("sha256", secret).update(exp).digest("hex");

/** cookie value = `${exp}.${HMAC_SHA256(secret, exp)}` */
export function signSession(secret: string, now = Date.now()): { value: string; exp: number } {
  const exp = now + SESSION_MS;
  return { value: `${exp}.${mac(secret, String(exp))}`, exp };
}

export function verifySession(
  value: string | null | undefined,
  secret = process.env.SESSION_SECRET,
  now = Date.now(),
): boolean {
  if (!value || !secret) return false;
  const i = value.indexOf(".");
  if (i < 1) return false;
  const exp = value.slice(0, i);
  if (!/^\d{1,16}$/.test(exp) || Number(exp) <= now) return false;
  return safeEqual(value.slice(i + 1), mac(secret, exp));
}

type CookieReq = Request & { cookies?: { get(n: string): { value: string } | undefined } };

/** Route-handler auth: bearer token, or (if allowed) a valid session cookie. */
export function isAuthorized(req: CookieReq, allowSession: boolean): boolean {
  if (checkToken(bearerOf(req.headers.get("authorization")))) return true;
  if (allowSession) return verifySession(req.cookies?.get(COOKIE_NAME)?.value);
  return false;
}
