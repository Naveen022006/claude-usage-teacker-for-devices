# 04 — Hub sync (contract)

All clients (Chrome extension, Claude Code daemon) push snapshots to the **Usage Hub**, a small
web app the user deploys once to Vercel (`hub/`). The hub combines every device logged in to the
same Claude account (Pro / Max) and shows **per device × per model** usage with tokens, plus the
account's plan limits. One hub = one Claude account = one owner.

## Auth
- One secret, `HUB_TOKEN` (env var on the hub, ≥ 24 chars). Clients send
  `Authorization: Bearer <HUB_TOKEN>`. Wrong/missing → `401 {"ok":false,"error":"unauthorized"}`.
- The dashboard uses the same secret once at `/login`, then an httpOnly signed session cookie.

## Endpoints
| Route | Behaviour |
|---|---|
| `GET /api/ping` | Auth required. `200 {"ok":true,"name":"Claude Usage Hub","v":1}` |
| `POST /api/report` | Auth required. Body = `Report` (below), ≤ 64 KB (`413`), invalid → `400`. Upserts the device's latest snapshot and the account snapshot. `200 {"ok":true}` |
| `GET /api/state` | Auth required (bearer or session). Merged view as JSON. |

## Report (unchanged v1 shape — `src/shared/types.ts`)
```json
{
  "v": 1,
  "deviceId": "8f1c…",
  "deviceName": "Laptop-Chrome",
  "source": "chrome",                 // "chrome" | "claude-code" | "desktop"
  "sentAt": 1760600000000,
  "windows": {
    "today":  { "messages": 12, "promptTokens": 3400, "outputTokens": 18000,
                "byModel": { "claude-opus-5-5": { "messages": 4, "tokens": 9000 } } },
    "last5h": { "...": "same shape" },
    "last7d": { "...": "same shape" }
  },
  "estimated": true,                  // true for chrome (char-based), false for transcript sources
  "account": { "fetchedAt": 1760599900000,
               "windows": [{ "name": "five_hour", "utilization": 42, "resetsAt": "…" }] }
}
```
Clients send **aggregates, not raw events**, and never any message text.

## Merge rules (hub and `tools/mock-hub.mjs`)
- Latest snapshot per `deviceId` wins (by `sentAt`; ignore older).
- **Fresh** = received < 10 min ago. Totals sum fresh devices only; stale devices are listed, dimmed,
  with "last seen".
- Per-model totals = sum of fresh devices' `byModel`.
- `account`: the snapshot with the newest `fetchedAt` across all devices wins. It is account-wide
  (includes untracked clients such as the mobile app or Desktop chat) — show it once, never sum it.

## When clients send
- After new usage (debounced 3 s) and every 60 s heartbeat.
- Timeout 10 s. On failure keep `lastError`; the next snapshot replaces it (nothing is lost).

## Chrome permission note
The hub URL is user-configured, so the extension requests it at save time via
`optional_host_permissions` (`https://*/*`, plus `http://*/*` for a local hub/mock).
