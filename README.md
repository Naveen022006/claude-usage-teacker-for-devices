# DeskBuddy Usage Tracker — Chrome Extension

Per-device tracking of Claude usage (which model, how many messages, approx. tokens) for the
ESP32 DeskBuddy display (Waveshare ESP32-S3 1.43" round AMOLED).

## Why this exists
Claude.ai only exposes **account-level** usage (e.g. "% of 5-hour limit used"). It does not tell
you *which device* used it, or how many tokens each model consumed. So each client
(Chrome, Desktop app, Claude Code terminal) must **measure its own usage locally** and report it
to DeskBuddy, which adds it all up.

Phase 1 (this folder) = **Chrome extension** for claude.ai.
Phase 2 (`daemon/`) = **deskbuddy-cc**, a Node daemon that reads Claude Code transcripts for exact token counts (see docs/09).

## Doc map
| File | What it covers |
|---|---|
| `CLAUDE.md` | Instructions for Claude Code when building this repo |
| `docs/01-architecture.md` | Components and data flow |
| `docs/02-data-capture.md` | How we observe claude.ai traffic and extract model/token data |
| `docs/03-data-model.md` | Event schema, storage, aggregation |
| `docs/04-device-sync.md` | API contract between extension and ESP32 |
| `docs/05-extension-structure.md` | Manifest V3, file layout, permissions |
| `docs/06-ui.md` | Popup / options page |
| `docs/07-testing.md` | How to verify accuracy |
| `docs/08-roadmap.md` | Phases: Chrome → Claude Code → Desktop app |
| `docs/09-claude-code-daemon.md` | Phase 2: Node daemon that reports Claude Code token usage from local transcripts |

## Ground rules
- Read-only: never modify requests to claude.ai, never send prompts/responses anywhere.
- Only counts and metadata leave the browser — **no message content**.
- Token numbers from the web app are **estimates** (see 02). Claude Code numbers will be exact.
