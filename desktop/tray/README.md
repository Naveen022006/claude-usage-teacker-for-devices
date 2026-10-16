# Usage Meter Tray (Windows)

A taskbar tray icon (next to Wi-Fi / sound) showing the Claude logo with a small status dot (bottom-right).
Click it for the usage popup: Session / Weekly limits with live reset countdowns, and a per-model split
(5h, Week, Tokens). Right-click for Show usage, Refresh, Start with Windows, Quit.

It is a plain PowerShell 5.1 script (System.Windows.Forms NotifyIcon, no compiled binaries), so Windows
Smart App Control does not block it. The data comes from the local Node server in `desktop/`.

## Start

Build once:

    cd desktop
    npm install
    npm run build

Then double-click `desktop\tray\Start-UsageMeter.cmd`, or run directly:

    powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File desktop\tray\UsageMeterTray.ps1

The tray starts the server (`node desktop\dist\server.cjs --headless --parent-pid <tray pid>`) if it is not
already running. Quit from the tray menu stops the server too (it also exits if the tray dies).

Start with Windows: right-click the icon and tick "Start with Windows". This creates / removes
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Usage Meter.lnk`.

## Tray icon

The Claude logo is loaded at runtime from the installed Claude Desktop app (Get-AppxPackage -Name Claude,
 then a running claude.exe); it is never copied into this repo. If it cannot be found, a drawn ring icon is used.
Dot colour = Session (5h) tone: blue under 80%, amber 80-94%, red 95%+, grey when the percentage is unknown.
A red dot with ! means the usage server is not running / unreachable.

## Where the data comes from

- Session / Weekly: Anthropic's usage API, using your Claude Code sign-in (or the Usage Hub as fallback).
- Models (shown with a leading approx sign when the server flags them as estimated): Claude Desktop / Claude Code session transcripts on this PC (model names, timestamps, token counts).
- The tray polls `http://127.0.0.1:<port>/u/<key>/api/tray` every 5 s (port/key from
  `%APPDATA%\UsageMeterDesktop\instance.json`).

## Privacy

Only counts are read; message text is never stored or sent. The server listens on 127.0.0.1 only.

## Troubleshooting

- Icon missing: Windows may hide it under the ^ overflow; drag it onto the taskbar.
- Grey icon with "!": server starting or not running. Make sure Node.js is installed and `npm run build`
  has produced `desktop\dist\server.cjs`. The tray retries automatically.
- Smart App Control: do not use packaged .exe launchers; this script only needs signed `powershell.exe` and `node.exe`.
  If the .cmd is blocked, run the powershell command above.
- Preview without the server: `powershell -NoProfile -ExecutionPolicy Bypass -File UsageMeterTray.ps1 -SelfTest`
  writes `selftest.png` / `selftest-icon.png` here (delete them afterwards). Add `-TestScale 1.5` to simulate DPI scaling (writes `selftest-1.5.png`).


## Claude account (sign-in)

- The popup subtitle shows the active account: "Claude Desktop - Max account" (tray login) or "Claude Code CLI account (Pro)" in amber (fallback, with a hint note).
- Requires the `claude` CLI on PATH.
