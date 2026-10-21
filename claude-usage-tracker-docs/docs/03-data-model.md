# 03 - Data model

> Verify field names against the real page/endpoint in Phase 0. Store only what is listed here.

## Tables (IndexedDB stores or SQLite, same shape)

```sql
-- account usage readings (one per read)
readings(
  ts TEXT NOT NULL,                  -- UTC ISO
  install_id TEXT,                   -- which extension install took it
  plan TEXT,
  win5h_pct REAL, win5h_resets_at TEXT,
  weekly_all_pct REAL, weekly_resets_at TEXT,
  weekly_by_model TEXT,              -- JSON, e.g. {"sonnet": 22.0}
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

-- every poll of a session's Updated value (activity signal)
session_updates(
  session_key TEXT NOT NULL,
  polled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_key, polled_at)
);

-- optional browser-side events (metadata only)
events(
  ts TEXT NOT NULL,
  install_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'send' | 'response_done'
  model TEXT,                        -- only if visible without reading content
  PRIMARY KEY (ts, install_id, kind)
);

-- optional Claude Code token evidence (from collector)
cc_usage(
  device_id TEXT NOT NULL, msg_key TEXT NOT NULL, ts TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INT, output_tokens INT, cache_write_tokens INT, cache_read_tokens INT,
  PRIMARY KEY (device_id, msg_key)
);

-- engine output
attribution(
  window_scope TEXT NOT NULL,        -- 'win5h' | 'weekly'
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
Cookies, auth headers, raw session ids, org/account ids, IPs, prompt/response content, tool output.

## Export (`estimates.json`)
```json
{
  "schema": 1,
  "generated_at": "2026-10-21T10:00:00Z",
  "windows": {
    "win5h": { "resets_at": "...", "total_pts": 16.0,
      "by_device": [ { "device_id": "...", "label": "Chrome (Windows)", "pts": 9.0, "confidence": "high" } ],
      "unattributed_pts": 2.0 },
    "weekly": { "...": "same shape" }
  }
}
```
