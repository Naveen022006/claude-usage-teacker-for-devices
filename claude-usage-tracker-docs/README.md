# Claude Usage Tracker - per-device 5-hour and weekly usage

Goal: take the **devices/sessions list** in the Claude account settings (Edge, Chrome, Claude Desktop,
Claude iOS, ...) and add what it lacks: **how much of the 5-hour window and the weekly limit each device has used.**

```
Device                 Location   Created   Updated   5h used     Weekly used   Confidence
Chrome (Windows) now   ...        ...       ...       9 pts       14 pts        High
Claude Desktop (Win)   ...        ...       ...       4 pts        6 pts        Medium
Claude (iOS)           ...        ...       ...       1 pt         2 pts        Low
Unattributed           -          -         -         2 pts        3 pts        -
```
(example numbers; "pts" = percentage points of the account's limit)

## Key idea
Anthropic shows account-wide usage % and a list of signed-in sessions, but never usage per session.
We build the missing link in the Chrome extension:

1. Read the account usage % often (5-hour and weekly).
2. Read the sessions list often and watch which sessions' **Updated** time changes.
3. When the % rises, attribute the rise to the session(s) that were active in that interval.
4. Add direct evidence where available: browser-side send events, and Claude Code token logs per device.
5. Sum attributed points per device since each window reset, and show them with a confidence label.

This is an estimate, not an official per-device number. See `docs/06-attribution.md`.

## Docs

| File | Covers |
|---|---|
| docs/01-overview.md | Goals, non-goals, success criteria |
| docs/02-architecture.md | Components and data flow |
| docs/03-data-model.md | Tables, export JSON |
| docs/04-collector-spec.md | Optional Claude Code log collector (precision for Claude Code) |
| docs/05-extension-integration.md | The extension: session reader, usage reader, events, storage |
| docs/06-attribution.md | How usage points are assigned to devices |
| docs/07-dashboard-spec.md | The per-device table and charts |
| docs/08-phases.md | Build order with checklists and Phase 0 experiments |
| docs/09-claude-code-kickoff.md | Prompt to start the build in Claude Code |
| docs/10-open-questions.md | Things to verify, with a table to fill in |

## Quick start
1. Read docs 01, 05 and 06.
2. Run the Phase 0 experiments in `docs/08-phases.md` (they decide how accurate this can be).
3. Empty repo, copy this folder in, put your extension in `extension/`, paste `docs/09-claude-code-kickoff.md` into Claude Code.

## Status
Planning. Extension exists (reads usage), session-list reading and attribution not built.
