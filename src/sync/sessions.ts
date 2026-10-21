// WARNING: UNDOCUMENTED claude.ai endpoint. First page only; never throws.
import { SESSIONS_PATH, parseSessions } from "../capture/sessionsParser";

export interface SessionsDiag {
  at: number;
  status: number | null;
  count: number;
  hasMore: boolean;
  uaKeys: string[];
  parsed: boolean;
}

export async function fetchSessions(onDiag?: (d: SessionsDiag) => void): Promise<ReturnType<typeof parseSessions>> {
  const at = Date.now();
  const fail = (status: number | null) => onDiag?.({ at, status, count: 0, hasMore: false, uaKeys: [], parsed: false });
  try {
    const res = await fetch("https://claude.ai" + SESSIONS_PATH, { credentials: "include", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn("[claude-usage] sessions endpoint HTTP", res.status);
      fail(res.status);
      return null;
    }
    const parsed = parseSessions(await res.json());
    if (!parsed) console.warn("[claude-usage] unknown sessions response shape");
    onDiag?.({
      at,
      status: res.status,
      count: parsed?.sessions.length ?? 0,
      hasMore: parsed?.hasMore ?? false,
      uaKeys: parsed?.uaKeys ?? [],
      parsed: !!parsed,
    });
    return parsed;
  } catch (e) {
    console.warn("[claude-usage] sessions fetch failed", e);
    fail(null);
    return null;
  }
}
