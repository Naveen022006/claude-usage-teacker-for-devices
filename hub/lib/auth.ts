import { createHash, timingSafeEqual } from "node:crypto";

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

/** Route-handler auth: Authorization: Bearer <HUB_TOKEN> only. */
export function isAuthorized(req: Request): boolean {
  return checkToken(bearerOf(req.headers.get("authorization")));
}
