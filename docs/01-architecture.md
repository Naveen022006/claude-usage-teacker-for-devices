# 01 — Architecture

```
 Chrome extension (src/)          Claude Code daemon (daemon/)
 claude.ai stream -> estimate     ~/.claude/projects transcripts -> exact usage
        │                                   │
        └──── HTTPS  POST /api/report ──────┘     Authorization: Bearer <HUB_TOKEN>
                          │
                          ▼
              Usage Hub (hub/, Next.js on Vercel)
              latest snapshot per device, merged per model, account limits
                          │
                          ▼
                 Dashboard (browser, /login with the same token)
```

## Inside the extension
```
claude.ai tab
 ├─ inject.ts   (MAIN world, document_start): wraps fetch, tees completion streams, parses SSE,
 │              window.postMessage({ns:"claude-usage", ...})
 └─ bridge.ts   (ISOLATED world): checks origin + source -> chrome.runtime.sendMessage
background service worker (sw.ts)
 ├─ validates + stores events in chrome.storage.local, rolling aggregates (today / 5h / 7d)
 ├─ polls account usage (optional, see 02 §4)
 └─ pushes a snapshot to the hub (debounced after usage + 60 s heartbeat)
popup.html — this device's stats + hub sync status
```
Why two content scripts: only the MAIN world can wrap the page's `fetch`, but it can't call `chrome.*`.

## Device identity
On install the extension generates a UUID `deviceId`; the user sets a `deviceName` in options.
Multiple Chrome profiles = multiple devices. The daemon reports one device per source
(Claude Code, and Desktop Code sessions as `<id>-desktop`).

## Two independent numbers
1. **Per-device usage** — measured by us (messages, model, tokens).
2. **Account usage** — read from claude.ai (% of limits). Same on every device; the hub shows it once, never sums it.
