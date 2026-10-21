// Small pure helpers for the service worker: /usage read back-off and the org-id hash sent to the tray.

const BACKOFF_STEPS_MS = [2, 4, 8, 15].map((m) => m * 60_000);

/** Wait after the Nth consecutive failed /usage read (1-based): 2, 4, 8, then 15 minutes. 0 failures = no wait. */
export function nextBackoffMs(failures: number): number {
  if (!(failures >= 1)) return 0;
  return BACKOFF_STEPS_MS[Math.min(Math.floor(failures), BACKOFF_STEPS_MS.length) - 1];
}

/** First 32 hex chars of SHA-256 of the org id; null stays null. */
export async function orgHash(orgId: string | null): Promise<string | null> {
  if (orgId === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orgId));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
