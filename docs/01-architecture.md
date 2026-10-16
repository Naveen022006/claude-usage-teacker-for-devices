# 01 — Architecture

```
claude.ai tab
 ├─ inject.ts        (MAIN world, document_start)
 │    wraps window.fetch → tees completion streams → parses SSE
 │    posts {type:"usage-event", ...} via window.postMessage
 └─ bridge.ts        (ISOLATED world content script)
      listens for postMessage (checks origin + source) → chrome.runtime.sendMessage
                │
                ▼
background service worker (sw.ts)
 ├─ validates + stores events in chrome.storage.local
 ├─ maintains rolling aggregates (today / 5h window / 7d)
 ├─ polls account usage endpoint every N min (optional, see 02 §4)
 └─ pushes snapshot to DeskBuddy (ESP32) over LAN HTTP  ──►  ESP32 /api/report
                │
                ▼
popup.html — shows this device's stats + DeskBuddy connection status
```

## Why two content scripts
The page's own `fetch` can only be wrapped from the **MAIN world**, but MAIN-world scripts
can't call `chrome.*` APIs. So `inject.ts` observes, `bridge.ts` forwards.

## Device identity
On install, the SW generates a UUID `deviceId` and stores it. User sets a friendly
`deviceName` (e.g. "Laptop-Chrome") in options. Every report carries both.
Multiple Chrome profiles = multiple devices (each profile has its own storage). That's intended.

## Two independent numbers
1. **Per-device usage** — measured by us (messages, model, estimated tokens).
2. **Account usage** — read from claude.ai (% of limits). Same value on every device;
   DeskBuddy should show it once, not sum it.
