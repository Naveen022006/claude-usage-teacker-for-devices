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
  widget/
    widget.ts        # ISOLATED content script (document_idle): closed-shadow-DOM usage widget
    helpers.ts       # pure formatters / device merge (tested)
    styles.ts        # constructable stylesheet text
  sw.ts              # service worker: storage, aggregates, alarms, sync, widget state
  sync/hub.ts        # report/ping + fetchHubState (GET /api/state)
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
  "name": "Claude Usage Tracker",
  "version": "0.1.0",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://claude.ai/*"],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://claude.ai/*"], "js": ["inject.js"],
      "run_at": "document_start", "world": "MAIN" },
    { "matches": ["https://claude.ai/*"], "js": ["bridge.js"],
      "run_at": "document_start" },
    { "matches": ["https://claude.ai/*"], "js": ["widget.js"],
      "run_at": "document_idle" }
  ],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

## Messaging
`inject → window.postMessage({ns:"claude-usage", type:"usage-event", payload})`
`bridge` checks `event.source === window && data.ns === "claude-usage"`, then
`chrome.runtime.sendMessage`. SW validates every field type before storing.

## Widget messaging and permissions
No new permissions: the widget relies on `host_permissions` for claude.ai; the hub is reached by the
service worker through the existing optional host permission. Content script -> SW (only when
sender.tab is on https://claude.ai/; wrapped `{ns:"claude-usage", type}`):
- `get-widget-state` -> `WidgetState` (device, local aggregates, accountUsage, syncState, showWidget,
  hub{configured, ok, error?, fetchedAt, devices[]}). Hub state is fetched with the Bearer token
  (`fetchHubState`, 10 s timeout, never throws) and cached in memory for 30 s. If account usage is
  older than 2 min and an orgId is known, the SW refreshes it (max once per minute).
- `open-options` -> `chrome.runtime.openOptionsPage()`.
SW -> widget: `chrome.tabs.sendMessage(tabId, {ns, type:"state-changed"})` after each new usage event
or account-usage refresh. The widget stores `widgetUi` ({expanded, bottom}) in `chrome.storage.local`.
These are the only content-script messages that receive a response.
