# 09 — Claude Code daemon (phase 2)

`deskbuddy-cc` is a small Node daemon (`daemon/`) that reads Claude Code's local session
transcripts and reports **exact** token usage to DeskBuddy via the same `POST /api/report`
contract as the extension (`source:"claude-code"`, `estimated:false`).

## What it measures
- Source: `<projectsDir>/<project>/<sessionId>.jsonl` plus subagent files
  `<sessionId>/subagents/agent-*.jsonl`, scanned recursively. Default projectsDir is
  `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).
- One event per API reply, from `type:"assistant"` lines: `message.id`, `model`, `usage`, `timestamp`.
- **prompt tokens = input + cache_creation + cache_read**; output tokens = `output_tokens`
  (thinking tokens are already included in it).
- One reply is written as several lines repeating the same `message.id`/usage, and resumed or
  forked sessions may copy lines into new files, so events are **deduped by message.id across all files**.
- `<synthetic>` model messages (local, no API usage) are skipped.
- Files are tailed incrementally via per-file byte cursors, so rescans are cheap.

## Per-client split (phase 3)
Events are tagged by the line's `entrypoint`: `claude-desktop` -> `source:"desktop"`, everything else -> `claude-code`.
The daemon sends **one report per source** with events in the last 7 days (deviceId `<id>` and `<id>-desktop`,
names `<host>-ClaudeCode` / `<host>-Desktop`, see `config --desktop-name`). Details and limits: docs/10.

## Privacy
Only ids, model, timestamp and usage numbers are read or stored. Message content is never kept or logged.

## Install / run
```
npm install
npm run build                       # builds extension and daemon -> daemon/dist/deskbuddy-cc.mjs
npm run daemon -- once --dry-run    # scan, print totals and the report JSON, send nothing
npm run daemon -- config --url http://deskbuddy.local [--token SECRET] [--name MyPC-ClaudeCode]
npm run daemon -- ping
npm run daemon -- run               # long-running (default command)
npm run daemon -- status
```
Config: `~/.deskbuddy/claude-code.json`; state (cursors + last 30 days of events):
`~/.deskbuddy/claude-code-state.json`. `DESKBUDDY_URL` and `DESKBUDDY_TOKEN` env vars override the file; `DESKBUDDY_HOME` relocates the directory.
State carries a `rev` marker; an older state is reset once on load so events are re-tagged by client.
Defaults: scan every 10 s, heartbeat sync every 60 s, new replies sync after a 3 s debounce, first-run backfill 7 days.

## Autostart
Use absolute paths (find node with `where node` / `which node`).

**Windows (Task Scheduler)**
```
schtasks /create /tn "deskbuddy-cc" /sc onlogon /tr "\"C:\Program Files\nodejs\node.exe\" \"E:\path\to\repo\daemon\dist\deskbuddy-cc.mjs\" run"
```

**macOS (launchd)** — `~/Library/LaunchAgents/com.deskbuddy.cc.plist`, then `launchctl load` it:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.deskbuddy.cc</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/repo/daemon/dist/deskbuddy-cc.mjs</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

**Linux (systemd --user)** — `~/.config/systemd/user/deskbuddy-cc.service`, then
`systemctl --user enable --now deskbuddy-cc`:
```ini
[Unit]
Description=DeskBuddy Claude Code usage reporter

[Service]
ExecStart=/usr/bin/node /path/to/repo/daemon/dist/deskbuddy-cc.mjs run
Restart=on-failure

[Install]
WantedBy=default.target
```
