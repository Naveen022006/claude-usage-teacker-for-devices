import { emptyLedger, normalizeLedger } from "./shared/attribution";
import type { Ledger } from "./shared/attribution";
import { DEFAULT_SETTINGS, DEFAULT_SW_DIAG, DEFAULT_SYNC_STATE, type DeviceInfo, type StorageShape } from "./shared/types";

type Defaulted = Exclude<keyof StorageShape, "device">;
const DEFAULTS: { [K in Defaulted]: StorageShape[K] } = {
  events: [],
  accountUsage: null,
  limitHint: null,
  orgId: null,
  plan: null,
  settings: DEFAULT_SETTINGS,
  syncState: DEFAULT_SYNC_STATE,
  captureDiag: null,
  swDiag: DEFAULT_SW_DIAG,
  usageDiag: null,
  trayDiag: null,
  limitLedger: emptyLedger(),
};

/** Pre-pivot settings used deskbuddyUrl / sharedToken. Rename once, drop the old LAN default. */
async function migrateSettings(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!("deskbuddyUrl" in raw) && !("sharedToken" in raw)) return raw;
  const { deskbuddyUrl, sharedToken, ...rest } = raw;
  const next: Record<string, unknown> = { ...rest };
  if (next.hubUrl === undefined && typeof deskbuddyUrl === "string") {
    next.hubUrl = deskbuddyUrl === "http://deskbuddy.local" ? "" : deskbuddyUrl;
  }
  if (next.hubToken === undefined && typeof sharedToken === "string") next.hubToken = sharedToken;
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function get(key: "device"): Promise<DeviceInfo | undefined>;
export async function get<K extends Defaulted>(key: K): Promise<StorageShape[K]>;
export async function get(key: keyof StorageShape): Promise<unknown> {
  let v = (await chrome.storage.local.get(key))[key];
  if (key === "settings" && v && typeof v === "object") v = await migrateSettings(v as Record<string, unknown>);
  if (key === "device") return v ?? undefined;
  if (v === undefined || v === null) return DEFAULTS[key];
  // merge so newly added fields get defaults
  if (key === "settings" || key === "syncState" || key === "swDiag") return { ...DEFAULTS[key], ...v };
  return v;
}

export async function set(partial: Partial<StorageShape>): Promise<void> {
  await chrome.storage.local.set(partial);
}

export async function ensureDevice(): Promise<DeviceInfo> {
  const d = await get("device");
  if (d?.deviceId) return d;
  const fresh: DeviceInfo = { deviceId: crypto.randomUUID(), deviceName: "Chrome" };
  await set({ device: fresh });
  return fresh;
}

let ledgerChain: Promise<unknown> = Promise.resolve();
/** Serialises read-modify-write on `limitLedger`. */
export function mutateLedger(fn: (l: Ledger) => Ledger): Promise<Ledger> {
  const run = ledgerChain.then(async () => {
    const cur = normalizeLedger(await get("limitLedger"));
    const next = fn(cur);
    if (next !== cur) await set({ limitLedger: next });
    return next;
  });
  ledgerChain = run.catch(() => undefined);
  return run;
}

let chain: Promise<unknown> = Promise.resolve();
/** Serialises read-modify-write on `events` so concurrent arrivals don't lose updates. */
export function mutateEvents(
  fn: (events: StorageShape["events"]) => StorageShape["events"],
): Promise<StorageShape["events"]> {
  const run = chain.then(async () => {
    const next = fn(await get("events"));
    await set({ events: next });
    return next;
  });
  chain = run.catch(() => undefined);
  return run;
}
