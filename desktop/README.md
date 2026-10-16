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

- Plan limits: read from your Usage Hub (`GET /api/state`, `account` field), using the same config the Claude Code daemon uses: `~/.claude-usage-hub/claude-code.json` (`hubUrl`, `hubToken`), or `CLAUDE_USAGE_HUB_HOME`, or the env vars `CLAUDE_USAGE_HUB_URL` / `CLAUDE_USAGE_HUB_TOKEN`. Polled every 60 s and shortly after new local replies. Without a hub the window shows local usage only.
- Local usage: Claude Code / Claude Desktop Code-session transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), scanned for model names, timestamps and token counts only.
- Per-model plan split is attributed from changes in plan usage after each reply (estimate).

## Limitations

- Plan-limit freshness depends on the Chrome extension (with account polling on) posting to the hub; the footer shows how old the reading is.
- Chats in the Claude Desktop chat tab leave no local transcript, so they cannot be attributed per model; their share shows up under "Other".
- No login in this version; sign-in is not offered (configure the hub in the extension / daemon).

## Privacy

Only counts are kept. Message text is never stored or transmitted. The hub token is read from the daemon config, sent only to your own hub as a Bearer header, and never logged. The local server binds to 127.0.0.1 only, uses a random per-run key in the URL path, and rejects requests with a foreign Host header, so other web pages on your PC cannot read it.
