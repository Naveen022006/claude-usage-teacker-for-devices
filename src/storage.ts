import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATE, type DeviceInfo, type StorageShape } from "./shared/types";

type Defaulted = Exclude<keyof StorageShape, "device">;
const DEFAULTS: { [K in Defaulted]: StorageShape[K] } = {
  events: [],
  accountUsage: null,
  limitHint: null,
  orgId: null,
  settings: DEFAULT_SETTINGS,
  syncState: DEFAULT_SYNC_STATE,
};

export async function get(key: "device"): Promise<DeviceInfo | undefined>;
export async function get<K extends Defaulted>(key: K): Promise<StorageShape[K]>;
export async function get(key: keyof StorageShape): Promise<unknown> {
  const v = (await chrome.storage.local.get(key))[key];
  if (key === "device") return v ?? undefined;
  if (v === undefined || v === null) return DEFAULTS[key];
  // merge so newly added fields get defaults
  if (key === "settings" || key === "syncState") return { ...DEFAULTS[key], ...v };
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
