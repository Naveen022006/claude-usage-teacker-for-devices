// Char → token estimate. Web-app numbers are always estimates (docs/02 §5); the UI shows "≈".

export const DEFAULT_CHARS_PER_TOKEN = 3.6;
export const MIN_CHARS_PER_TOKEN = 2.5;
export const MAX_CHARS_PER_TOKEN = 5;

export function clampCharsPerToken(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_CHARS_PER_TOKEN;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, n));
}

export function estimateTokens(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / clampCharsPerToken(charsPerToken));
}
