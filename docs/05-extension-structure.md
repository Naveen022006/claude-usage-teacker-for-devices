# 05 — Extension structure

## File layout
```
src/
  manifest.json
  capture/
    inject.ts        # MAIN world fetch hook
    sse.ts           # SSE line parser (pure, tested)
    claudeParser.ts  # maps SSE events → partial UsageEvent
    tokens.ts        # char → token estimate
  bridge.ts          # ISOLATED content script
  sw.ts              # service worker: storage, aggregates, alarms, sync
  sync/deskbuddy.ts
  popup/ popup.html popup.ts popup.css
  options/ options.html options.ts
test/
  fixtures/*.sse
  sse.test.ts  claudeParser.test.ts  aggregate.test.ts
```

## manifest.json (starting point)
```json
{
  "manifest_version": 3,
  "name": "DeskBuddy Usage Tracker",
  "version": "0.1.0",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://claude.ai/*"],
  "optional_host_permissions": ["http://*/*"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://claude.ai/*"], "js": ["inject.js"],
      "run_at": "document_start", "world": "MAIN" },
    { "matches": ["https://claude.ai/*"], "js": ["bridge.js"],
      "run_at": "document_start" }
  ],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

## Messaging
`inject → window.postMessage({ns:"deskbuddy", type:"usage-event", payload})`
`bridge` checks `event.source === window && data.ns === "deskbuddy"`, then
`chrome.runtime.sendMessage`. SW validates every field type before storing.
