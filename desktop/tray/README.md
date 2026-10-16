# Usage Meter Tray (Windows)

A taskbar tray icon (next to Wi-Fi / sound) showing your Claude Session (5h) percentage as a ring + number.
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

## Where the data comes from

- Session / Weekly: Anthropic's usage API, using your Claude Code sign-in (or the Usage Hub as fallback).
- Models: Claude Desktop / Claude Code session transcripts on this PC (model names, timestamps, token counts).
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
  writes `selftest.png` / `selftest-icon.png` here (delete them afterwards).
