# 04 — DeskBuddy sync

The ESP32 runs a small HTTP server on the LAN. The extension pushes; the ESP32 never pulls.

## Endpoint
`POST http://deskbuddy.local/api/report` (URL configurable; fall back to IP if mDNS fails)

```json
{
  "v": 1,
  "deviceId": "8f1c…",
  "deviceName": "Laptop-Chrome",
  "source": "chrome",
  "sentAt": 1760600000000,
  "windows": {
    "today":  { "messages": 12, "promptTokens": 3400, "outputTokens": 18000,
                "byModel": { "claude-opus-5-5": { "messages": 4, "tokens": 9000 } } },
    "last5h": { "...": "same shape" },
    "last7d": { "...": "same shape" }
  },
  "estimated": true,
  "account": { "fetchedAt": 1760599900000,
               "windows": [{ "name": "five_hour", "utilization": 42, "resetsAt": "…" }] }
}
```
Send **aggregates, not raw events** — the ESP32 has little RAM. It keeps the latest report
per `deviceId` and sums across devices for display. `account` is shown once (newest wins).

## When to send
- After each new event (debounced 3 s)
- Every 60 s heartbeat while browser is open (`chrome.alarms`)
- Response `200 {"ok":true}` → update `syncState.lastOkAt`

## Failure handling
Timeout 3 s. On failure, keep `syncState.lastError`, retry on next alarm. Nothing is lost
because the next report is a full snapshot.

## Security
- Optional shared token: header `X-DeskBuddy-Token`, set in both options page and ESP32 config.
- ESP32 should reject bodies > 4 KB.

## Permissions note
Pushing to `http://deskbuddy.local` from the service worker needs a matching
`host_permissions` entry. Use `optional_host_permissions` and request it when the user
saves the URL in options.
