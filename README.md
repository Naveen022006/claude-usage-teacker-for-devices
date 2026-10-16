# Claude Usage Tracker

See your Claude Pro/Max usage **per device and per model**, with tokens and plan limits, in one place.

Claude.ai only shows account-level usage ("42% of your 5-hour limit"). It doesn't say which device
used it or which model burned the tokens. Each client here measures its own usage locally and pushes
counts (never message text) to your own **Usage Hub**, which adds everything up for one Claude account.

## Components
| Component | Where | What it does |
|---|---|---|
| Chrome extension | `src/` | Observes claude.ai streams, estimates tokens, shows an in-page usage widget on claude.ai (plus a minimal popup), pushes to the hub |
| Claude Code daemon | `daemon/` | `claude-usage-daemon` reads local Claude Code / Desktop transcripts (exact tokens), pushes to the hub |
| Usage Hub | `hub/` (Next.js on Vercel) | Merges all devices, shows device x model usage and plan limits |

Clients talk to the hub over HTTPS with a single secret (`HUB_TOKEN`, sent as `Authorization: Bearer`).
Contract: `docs/04-device-sync.md`.

## Phases
| # | Phase | Status |
|---|---|---|
| 1 | Chrome extension | ✅ |
| 2 | Claude Code daemon | ✅ |
| 3 | Claude Desktop vs Code split | ✅ |
| 4 | Usage Hub (Vercel) | ⏳ |

## Quick start
```
npm install
npm run build                      # dist/ (load unpacked in Chrome) + daemon/dist/claude-usage-daemon.mjs
npm test
npm run mock                       # local stand-in for the hub: http://127.0.0.1:8787 (HUB_TOKEN=secret to require auth)
npm run daemon -- config --url http://127.0.0.1:8787 --token secret
npm run daemon -- once
```
Extension: options page -> Hub URL, Hub token, Test connection, enable sync.

## Doc map
| File | What it covers |
|---|---|
| `CLAUDE.md` | Instructions for Claude Code when building this repo |
| `docs/01-architecture.md` | Components and data flow |
| `docs/02-data-capture.md` | How we observe claude.ai traffic |
| `docs/03-data-model.md` | Event schema, storage, aggregation |
| `docs/04-device-sync.md` | **Contract** between clients and the hub |
| `docs/05-extension-structure.md` | Manifest V3, file layout, permissions |
| `docs/06-ui.md` | In-page widget (primary UI), popup, options page |
| `docs/07-testing.md` | How to verify accuracy |
| `docs/08-roadmap.md` | Phases |
| `docs/09-claude-code-daemon.md` | Daemon install and usage |
| `docs/10-desktop-and-mock.md` | Desktop split; mock hub |

## Ground rules
- Read-only: never modify requests to claude.ai, never send prompts/responses anywhere.
- Only counts and metadata leave the device. No message content.
