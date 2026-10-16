# 10 — Claude Desktop split (phase 3) and the mock DeskBuddy

## Phase 3 approach
The Claude Desktop app's **Code sessions** write the same transcripts as the terminal CLI, into the
same `~/.claude/projects`. Every transcript line carries a top-level `entrypoint` string:

| `entrypoint` | Client | Event `source` |
|---|---|---|
| `claude-desktop` | Claude Desktop app (Code sessions) | `desktop` |
| `cli`, `claude-vscode`, anything else or missing | Terminal / VS Code extension | `claude-code` |

The daemon (`daemon/`) tags each event accordingly and sends **one report per source that has events
in the last 7 days**:

| Source | `deviceId` | `deviceName` |
|---|---|---|
| `claude-code` | `cfg.deviceId` | `cfg.deviceName` (`<host>-ClaudeCode`) |
| `desktop` | `<cfg.deviceId>-desktop` | `cfg.desktopDeviceName` (`<host>-Desktop`, `config --desktop-name N`) |

Both reports are exact (`estimated:false`). A sync counts as successful only if every send succeeded;
the first error is recorded in `lastSync.error`. `once` / `status` print aggregates per source;
`once --dry-run` prints all reports.

### Limits
- Claude Desktop's plain **chat tab writes nothing locally** and is not tracked per message; it is
  covered only by the account-level 5h % ring (`account`).
- VS Code and terminal usage are not separated (both `claude-code`).
- Desktop usage on other machines needs the daemon running there too.

### One-time migration
Older daemon state tagged everything `claude-code`. `DaemonState.rev` (new, optional) marks the
tagging revision (`STATE_REV = 2`). A state file without `rev >= 2` is reset on load (cursors and
events dropped, `lastSync` kept) so transcripts are re-read and re-tagged once (7-day backfill).

## Mock DeskBuddy server
`tools/mock-deskbuddy.mjs` (zero dependencies) implements `firmware/SPEC.md` "HTTP API" and
"Merge rules" so you can test without hardware. The pure merge logic is in `tools/mock-merge.mjs`
(tested by `test/mockMerge.test.ts`).

```
npm run mock                         # http://127.0.0.1:8787
PORT=9000 DESKBUDDY_TOKEN=secret npm run mock
```
- `POST /api/report` (401 bad token, 413 > 4096 B, 400 bad JSON / `v != 1` / no `deviceId`),
  `GET /api/ping`, `GET /api/state` (merged JSON), `GET /` (auto-refreshing status table).
- Each accepted report prints a compact merged table to the console.

### Pointing clients at it
- **Daemon:** `DESKBUDDY_URL=http://127.0.0.1:8787 npm run daemon -- once`
  (add `DESKBUDDY_TOKEN=secret` if the mock has a token). Set `DESKBUDDY_HOME=<dir>` to keep config and
  state out of `~/.deskbuddy` while experimenting.
- **Extension:** options page -> DeskBuddy URL `http://127.0.0.1:8787` (grant the host permission when
  prompted), token if set, enable sync.
