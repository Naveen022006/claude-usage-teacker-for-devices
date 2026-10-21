# 05 - The extension (core of the project)

The extension already reads usage. This document defines everything it must do for per-device usage.
Phase 0 maps each requirement to what the current code already does.

## 1. Usage reader
- Read 5-hour % and weekly % (all models, plus per-model if shown) with reset times.
- Keep **history**, not only the latest value (cap at about 90 days).
- Read frequency (all configurable in options):
  - after any response completes in this browser (event-triggered, debounced),
  - every 1-2 minutes while a Claude tab is open,
  - every 5 minutes otherwise (`chrome.alarms`).
- Fail soft: if the value cannot be read, store nothing and show "could not read".

## 2. Session reader
- Read the sessions list: device label, Location, Created, Updated, Current badge.
- Same polling cadence as the usage reader, always together, so each poll yields one consistent pair
  (usage %, all sessions' Updated).
- For each row: upsert into `sessions`, append `session_updates` only when `Updated` changed or at a slow heartbeat.
- The Current row identifies this browser: store `current_for_install`.
- Identify rows by salted hash of (label + Created). Do not keep raw ids. Location only if enabled in options.
- Source: whichever Phase 0 finds stable (page DOM when the settings page is open, or an endpoint the page already calls
  using the user's own session). Never export credentials.

## 3. Event recorder (optional, phase 3)
- Goal: know "this browser sent a message at T". Strongest evidence for browser devices.
- Use the least intrusive method that works (for example observing the send action in the page, or request
  timing metadata). Record timestamp, install id and kind only. Never read bodies, never read content.
- If it needs broad permissions, skip it; the sessions-list signal may be enough.

## 4. Options page
- Device alias for this install (defaults to the Current row's label).
- Polling intervals, history retention, location on/off, event recorder on/off.
- Alias and merge editor for sessions (merge several rows into one device, for example the three
  Claude Desktop rows if they are one PC).
- Export/import buttons (JSON) and "Delete all data".

## 5. Surfaces
- **Extension page** (stable, built first): per-device table and charts (`07-dashboard-spec.md`).
- **Injected columns** (optional, fragile, last): a content script adds "5h used" and "Weekly used" next to the
  existing columns on the settings page. Keep it behind a toggle and degrade silently if the page structure changes.

## 6. Rules
- Manifest V3, service worker, `chrome.alarms`, IndexedDB. Minimal host permissions (the Claude site, plus the sync origin in phase 5).
- Poll politely; no tight loops; back off on errors.
- Version every export (`"schema": 1`).
- Keep all parsing in one module with fixture tests, since page structure can change.

## 7. Coverage by device type
| Device type | Extension installed? | Evidence |
|---|---|---|
| Chrome / Edge (Windows, Mac) | Yes (multi-instance mode) | Sessions list + send events + Current identity |
| Claude Desktop (Windows) | No | Sessions list Updated + Claude Code logs if used there |
| Claude iOS | No | Sessions list Updated only (low confidence) |
