// Usage reading history in IndexedDB (database "usage-meter", store "readings", keyed by timestamp).
// A row is appended only when something changed (or as an hourly heartbeat), and rows older than 90 days are pruned.
// Every exported async function fails soft: history is a convenience, it must never break the poll loop.

import type { AccountUsage, AccountWindow, Plan } from "./shared/types";

export interface HistoryReading {
  ts: number; // epoch ms (keyPath)
  installId: string;
  plan: Plan | null;
  windows: AccountWindow[];
}

const DB_NAME = "usage-meter";
const STORE = "readings";
export const RETENTION_MS = 90 * 24 * 3600_000;
const HEARTBEAT_MS = 3600_000;
const PRUNE_EVERY_MS = 3600_000;

/** Whether `next` is worth a new row: first reading, any window changed/added/removed, or an hourly heartbeat. */
export function shouldAppend(prev: { ts: number; windows: AccountWindow[] } | null, next: AccountUsage, now: number): boolean {
  if (!prev) return true;
  if (now - prev.ts >= HEARTBEAT_MS) return true;
  if (prev.windows.length !== next.windows.length) return true;
  const old = new Map(prev.windows.map((w) => [w.name, w]));
  for (const w of next.windows) {
    const o = old.get(w.name);
    if (!o || o.utilization !== w.utilization || o.resetsAt !== w.resetsAt) return true;
  }
  return false;
}

// ---- tiny IndexedDB wrapper ----

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "ts" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    dbPromise = null; // allow a retry next time
    throw e;
  });
  return dbPromise;
}

let lastPrune = 0;

/** Appends a reading if it differs from the last one. Never throws. */
export async function appendReading(usage: AccountUsage, installId: string, plan: Plan | null): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = await req(store.openCursor(null, "prev"));
    const prev = (cursor?.value as HistoryReading | undefined) ?? null;
    const now = Date.now();
    if (shouldAppend(prev, usage, now)) {
      store.put({ ts: usage.fetchedAt, installId, plan, windows: usage.windows } satisfies HistoryReading);
    }
    if (now - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now;
      store.delete(IDBKeyRange.upperBound(now - RETENTION_MS));
    }
    await done(tx);
  } catch (e) {
    console.warn("[claude-usage] history append failed", e);
  }
}

/** Readings with ts >= sinceMs, oldest first. Never throws. */
export async function listReadings(sinceMs: number): Promise<HistoryReading[]> {
  try {
    const db = await openDb();
    return (await req(db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.lowerBound(sinceMs)))) as HistoryReading[];
  } catch (e) {
    console.warn("[claude-usage] history read failed", e);
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch (e) {
    console.warn("[claude-usage] history clear failed", e);
  }
}
