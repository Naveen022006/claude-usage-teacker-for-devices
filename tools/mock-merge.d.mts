export const FRESH_MS: number;
export const MAX_BODY: number;
export const WINDOWS: string[];
export function validateReport(r: unknown): any | null;
export function newState(): { devices: Map<string, any>; account: any | null };
export function applyReport(state: ReturnType<typeof newState>, report: any, now?: number): ReturnType<typeof newState>;
export function isFresh(d: { receivedAt: number }, now?: number): boolean;
export function mergedView(state: ReturnType<typeof newState>, now?: number): { devices: any[]; totals: Record<string, any>; account: any | null };
