# 03 — Data model

## UsageEvent (one per completed reply)
```ts
interface UsageEvent {
  id: string;            // message id from stream, else uuid
  ts: number;            // epoch ms when stream finished
  source: "chrome";      // later: "claude-code" | "desktop"
  deviceId: string;
  model: string;         // e.g. "claude-sonnet-5-5" or "unknown"
  promptChars: number;
  outputChars: number;
  thinkingChars: number;
  promptTokens: number;  // estimated
  outputTokens: number;  // estimated
  estimated: boolean;    // true for web
  status: "ok" | "error" | "aborted";
  kind: "new" | "retry";
}
```
No conversation ids, titles or text are stored.

## AccountUsage (latest snapshot only)
```ts
interface AccountUsage {
  fetchedAt: number;
  windows: { name: string; utilization: number; resetsAt?: string }[];
}
```

## Storage (`chrome.storage.local`)
| Key | Value |
|---|---|
| `device` | `{ deviceId, deviceName }` |
| `events` | ring buffer of last 30 days of `UsageEvent` (prune on write) |
| `accountUsage` | `AccountUsage` |
| `settings` | `{ hubUrl, hubToken, syncEnabled, charsPerToken, pollAccountUsage }` |
| `syncState` | `{ lastOkAt, lastError, queue: number }` |

Older installs stored `deskbuddyUrl` / `sharedToken`; they are renamed to `hubUrl` / `hubToken` on first read.

## Aggregates (computed, not stored)
For windows `today`, `last5h`, `last7d`:
`{ messages, promptTokens, outputTokens, byModel: { [model]: {messages, tokens} } }`
