# Usage Meter Desktop

A small always-on-top-style window showing your Claude usage: plan limits (5-hour session and weekly windows) with a per-model split, plus exact token counts from local Claude Code / Claude Desktop Code-session transcripts. It is the desktop companion of the Usage Meter Chrome extension.

## Why not Electron

Windows Smart App Control blocks unsigned executables, including `electron.exe` and any unsigned packaged app. This companion therefore ships no executable: the engine runs in Node (`node.exe` is signed) and the UI is shown in a Microsoft Edge app-mode window (`msedge.exe` is signed). It is the same renderer as before, served from a local server.

We never inject into or modify Claude Desktop (hardened MSIX app).

## Run

```
cd desktop
npm install
npm start
```

This builds, starts the local server and opens an Edge window (`--app` mode, own profile in `%APPDATA%\UsageMeterDesktop\edge-profile`). Closing the window (or the x button) stops the server. If Edge is missing, the URL is printed and opened in your default browser. A second `npm start` just opens another window on the running instance.

Set `USAGE_METER_NO_WINDOW=1` to run headless (server only).

## Data sources

- Plan limits come ONLY from Claude Desktop. A Claude Code `statusLine` command (`dist/statusline.cjs`, added to `~/.claude/settings.json`) receives Anthropic's `rate_limits` (5-hour and weekly used % and reset times) for the account of each session. It records them to `%APPDATA%/UsageMeterDesktop/desktop-limits.json` **only for sessions started by Claude Desktop** (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`, or the transcript's `entrypoint`); Claude Code CLI / VS Code sessions are ignored and print nothing. No credentials, logins or Anthropic API calls are used. The server reads that file every 15 s; until the first Desktop reply the note says "Waiting for Claude Desktop — send a message in its Code tab".
- Local usage: Claude Desktop Code-session transcripts only (CLI / VS Code excluded unless USAGE_METER_SOURCES says otherwise) in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), scanned for model names, timestamps and token counts only.
- Per-model plan split is attributed from changes in plan usage after each reply (estimate).

## Tray app

A Windows system-tray front-end (PowerShell) that runs this server with `--headless --parent-pid <pid>`. See [tray/README.md](tray/README.md).

Server flags: `--headless` (no Edge window, no idle shutdown; a second headless start prints "already running" and exits 0) and `--parent-pid <n>` (exit when that process is gone). `GET /u/<key>/api/tray` serves the tray state (`src/shared/tray.ts`).

## Limitations

- Plan-limit freshness depends on the Chrome extension (with account polling on) posting to the hub; the footer shows how old the reading is.
- Chats in the Claude Desktop chat tab leave no local transcript, so they cannot be attributed per model; their share shows up under "Other".
- No login in this version; sign-in is not offered (configure the hub in the extension / daemon).

## Privacy

No credentials are read. Only counts are kept. Message text is never stored or transmitted. The hub token is read from the daemon config, sent only to your own hub as a Bearer header, and never logged. The local server binds to 127.0.0.1 only, uses a random per-run key in the URL path, and rejects requests with a foreign Host header, so other web pages on your PC cannot read it.
