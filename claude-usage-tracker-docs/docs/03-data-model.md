# 03 - Data model

> Verify field names against the real page/endpoint in Phase 0. Store only what is listed here.

## Where things live (Phase 0 finding)
- Existing small state (settings, latest `accountUsage`, per-model ledger, captured reply events, device id)
  stays in `chrome.storage.local` as today.
- The new history tables below (`readings`, `sessions`, `session_updates`, `attribution`) go in **IndexedDB**:
  `chrome.storage.local` is capped at 10 MB and a reading every minute for 90 days would not fit.
- `install_id` = the existing random `device.deviceId` (UUID made on install, see `src/storage.ts`).

## Tables (IndexedDB stores)

```sql
-- account usage readings: appended only when any window value or reset time changed,
-- plus one heartbeat row per hour (so gaps are visible). Keeps 90 days.
readings(
  ts TEXT NOT NULL,                  -- UTC ISO
  install_id TEXT,                   -- which extension install took it
  plan TEXT,
  windows TEXT,                      -- JSON AccountWindow[] as parsed today, e.g.
                                     -- [{"name":"five_hour","utilization":12,"resetsAt":"..."},
                                     --  {"name":"seven_day","utilization":30,...},{"name":"seven_day_opus",...}]
                                     -- names are open-ended (new models appear), so no fixed columns
  PRIMARY KEY (ts, install_id)
);

-- sessions list rows
sessions(
  session_key TEXT PRIMARY KEY,      -- salted hash(label || created_at)
  device_label TEXT NOT NULL,        -- as shown, e.g. 'Chrome (Windows)'
  device_id TEXT,                    -- merged device group; defaults to session_key
  alias TEXT,                        -- user-chosen name
  created_at TEXT,
  first_seen TEXT, last_seen TEXT,
  last_updated TEXT,                 -- latest 'Updated' value observed
  current_for_install TEXT,          -- set when the row has the Current badge
  location TEXT                      -- optional, OFF by default
);

-- every change of a session's Updated value (activity signal), plus an hourly heartbeat
session_updates(
  session_key TEXT NOT NULL,
  polled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_key, polled_at)
);

-- browser-side events: ALREADY EXISTS as `events` (UsageEvent[]) in chrome.storage.local.
-- The MAIN-world fetch hook records one event per completed reply: time, model, estimated
-- input/output tokens (from character counts; text is discarded). No new table needed.

-- Claude Code / Claude Desktop token evidence: ALREADY EXISTS via the Usage Hub.
-- The daemon (daemon/) reports per-device, per-model token totals; the extension turns hub
-- snapshots into deltas (ledger.hubPrev in src/shared/attribution.ts). Replaces `cc_usage`.

-- engine output
attribution(
  window_scope TEXT NOT NULL,        -- 'five_hour' | 'seven_day' (same names as the usage parser)
  interval_start TEXT NOT NULL,
  interval_end TEXT NOT NULL,
  device_id TEXT,                    -- NULL = unattributed
  delta_pts REAL NOT NULL,
  confidence TEXT NOT NULL,          -- 'high' | 'medium' | 'low'
  method TEXT NOT NULL,              -- 'event' | 'updated' | 'tokens' | 'split' | 'none'
  PRIMARY KEY (window_scope, interval_start, device_id)
);
```

## Never stored
Cookies, auth headers, raw session ids, IPs, prompt/response content, tool output.

Exception: the claude.ai **org id** is kept in `chrome.storage.local` because the usage request path needs it
(`/api/organizations/{orgId}/usage`). It is never exported, never synced to the hub, and never sent anywhere
else in raw form. (Phase 1 fix: the push to the local tray app currently sends it raw; send a hash instead.)

## Export (`estimates.json`)
```json
{
  "schema": 1,
  "generated_at": "2026-10-21T10:00:00Z",
  "windows": {
    "five_hour": { "resets_at": "...", "total_pts": 16.0,
      "by_device": [ { "device_id": "...", "label": "Chrome (Windows)", "pts": 9.0, "confidence": "high" } ],
      "unattributed_pts": 2.0 },
    "seven_day": { "...": "same shape" }
  }
}
```
