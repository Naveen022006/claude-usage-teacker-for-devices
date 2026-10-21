import type { ParsedSession } from "../capture/sessionsParser";

export interface StoredSession {
  key: string;
  label: string;
  createdAt: string;
  lastUpdated: string;
  firstSeen: number;
  lastSeen: number;
  current: boolean;
}

const DAY = 86_400_000;
const MAX_AGE = 30 * DAY;
const MAX_STORED = 50;

export function diffSessions(
  prev: Record<string, StoredSession>,
  next: { key: string; s: ParsedSession }[],
  now: number,
): { store: Record<string, StoredSession>; changed: string[] } {
  const store: Record<string, StoredSession> = {};
  for (const [k, v] of Object.entries(prev)) if (now - v.lastSeen <= MAX_AGE) store[k] = v;
  const changed: string[] = [];
  for (const { key, s } of next) {
    const old = prev[key];
    if (old && !s.isCurrent) {
      const a = Date.parse(s.updatedAt);
      const b = Date.parse(old.lastUpdated);
      if (!Number.isNaN(a) && (Number.isNaN(b) || a > b) && !changed.includes(key)) changed.push(key);
    }
    store[key] = {
      key,
      label: s.label,
      createdAt: s.createdAt,
      lastUpdated: s.updatedAt,
      firstSeen: old ? old.firstSeen : now,
      lastSeen: now,
      current: s.isCurrent,
    };
  }
  const keys = Object.keys(store);
  if (keys.length > MAX_STORED) {
    keys.sort((a, b) => store[a].lastSeen - store[b].lastSeen);
    for (const k of keys.slice(0, keys.length - MAX_STORED)) delete store[k];
  }
  return { store, changed: changed.filter((k) => k in store) };
}
