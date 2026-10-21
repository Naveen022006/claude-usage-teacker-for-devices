# 05 - The extension (core of the project)

The extension already reads usage. This document defines everything it must do for per-device usage.
Phase 0 maps each requirement to what the current code already does.

## 0. What already exists (Phase 0, E1/E6 code reading)
- **Usage source**: the service worker calls `GET https://claude.ai/api/organizations/{orgId}/usage` with the
  browser's own claude.ai sign-in (`src/sync/accountUsage.ts`). The org id comes from `GET /api/organizations`
  or the `lastActiveOrg` cookie. The parser reads the newer `limits[{kind, percent, resets_at, scope}]` list first,
  then the older `five_hour` / `seven_day` fields, and outputs windows `five_hour`, `seven_day`,
  `seven_day_<model>` (0-100, with `resetsAt`). Fails soft (null + warning) and records a values-free shape
  diagnostic shown in Options.
- **Stored**: only the latest reading (`accountUsage`) plus a per-model attribution ledger
  (`src/shared/attribution.ts`). No history yet.
- **Cadence** (`src/sw.ts`): 1-minute `chrome.alarms` heartbeat; reads every ~1 min while a claude.ai tab is open,
  every 3 min otherwise; extra reads 4 s and 20 s after each reply; the widget triggers a read when the value is
  older than 2 min (at most once a minute). No back-off on HTTP errors yet.
- **Event recorder**: already built. A MAIN-world fetch hook (`src/capture/`) observes completion streams via
  `tee()` and records one event per reply (time, model, estimated tokens from character counts; text discarded).
- **Other devices' evidence**: the Usage Hub (Vercel + Neon) already receives per-device, per-model token totals
  from the Claude Code / Claude Desktop daemon; the extension reads them with `GET /api/state`.
- **Sessions list**: not read anywhere yet. Its source (endpoint or page only) and how the Current row is marked
  are unknown from code; see section 2.

## 1. Usage reader
- Read 5-hour % and weekly % (all models, plus per-model if shown) with reset times. (Exists.)
- Keep **history**, not only the latest value (cap at about 90 days), in IndexedDB. Append only on change plus an
  hourly heartbeat (see `03-data-model.md`).
- Read frequency (keep today's cadence; make it configurable in options):
  - 4 s and 20 s after any response completes in this browser,
  - every ~1 minute while a Claude tab is open,
  - every 3 minutes otherwise (`chrome.alarms`).
- Back off on errors: after an HTTP error or 429, wait 2, 4, 8, then 15 minutes before the next read.
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
- **Discovery step (before writing the reader)**: extend the existing fetch-hook diagnostic so that, on claude.ai
  settings pages only, it records the method and path of each same-origin `/api/` GET with every id segment replaced
  by `{id}`, plus the response's key names and types (no values, same as the `/usage` shape diagnostic). Shown in
  Options → Diagnostics; never stored beyond the last 20 entries, never synced. The user opens the sessions page
  once and reads the result.
  - If an endpoint returns the list: the service worker polls it right after each `/usage` read (one extra request).
  - If the list is page-only: it can be read only while the settings page is open, and devices without the
    extension fall back to Unattributed most of the time. Say so in the UI.
- Polling cost: with the sessions read added, about 2 requests per minute while a claude.ai tab is open and
  2 per 3 minutes otherwise.

## 3. Event recorder (already built)
- Goal: know "this browser sent a message at T". Strongest evidence for browser devices.
- Exists as the MAIN-world fetch hook (`src/capture/`): observes the completion stream with `tee()`, records time,
  model and estimated tokens per reply, never stores text. Uses only the existing claude.ai host permission.

## 4. Options page
- Device alias for this install (defaults to the Current row's label).
- Polling intervals, history retention, location on/off, event recorder on/off.
- Alias and merge editor for sessions (merge several rows into one device, for example the three
  Claude Desktop rows if they are one PC).
- Export/import buttons (JSON) and "Delete all data".

## 5. Surfaces
- **"Devices" tab in the claude.ai sidebar widget** (built first): the per-device table from `07-dashboard-spec.md`,
  next to the existing 5h / Today / Week tabs. This keeps all UI inside claude.ai, like the rest of the extension.
- **Extension page** (later, optional): charts and the evidence view from `07-dashboard-spec.md` that do not fit
  the sidebar.
- **Injected columns** (optional, fragile, last): a content script adds "5h used" and "Weekly used" next to the
  existing columns on the settings page. Keep it behind a toggle and degrade silently if the page structure changes.

## 6. Rules
- Manifest V3, service worker, `chrome.alarms`, IndexedDB. Minimal host permissions (the Claude site, the local
  tray app on 127.0.0.1, and the user's own Usage Hub origin, which is an optional permission granted in Options).
- Phase 5 sync uses the existing Usage Hub (Vercel + Neon, `Authorization: Bearer <token>`), not a new store.
- Poll politely; no tight loops; back off on errors.
- Version every export (`"schema": 1`).
- Keep all parsing in one module with fixture tests, since page structure can change.

## 7. Coverage by device type
| Device type | Extension installed? | Evidence |
|---|---|---|
| Chrome / Edge (Windows, Mac) | Yes (multi-instance mode) | Sessions list + reply events + Current identity |
| Claude Desktop (Windows) | No | Sessions list Updated + hub token totals from the daemon (Code sessions) |
| Claude Code CLI (any machine with the daemon) | No | Hub token totals per device (may have no sessions-list row) |
| Claude iOS | No | Sessions list Updated only (low confidence) |
