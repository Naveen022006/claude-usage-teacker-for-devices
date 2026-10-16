# 08 — Roadmap

| Phase | Client | How usage is measured | Accuracy |
|---|---|---|---|
| 1 | Chrome extension (this) | Observe claude.ai streams | Estimated |
| 2 | Claude Code terminal | Read local session transcripts (JSONL under `~/.claude/projects/`) — each assistant entry has a `usage` object with input/output/cache tokens and model. Small Node/Python daemon tails them and posts to the same `/api/report` with `source:"claude-code"`, `estimated:false`. Alternative: Claude Code's OpenTelemetry export. Verify current format before building. | Exact |
| 3 | Claude Desktop app | No extension API. Options: (a) desktop app MCP server can't see usage; (b) proxy/inspect is fragile. Likely show "account usage minus known devices" as "other". | Approx / derived |
| 4 | DeskBuddy firmware | Merge reports per device, round UI on 1.43" AMOLED: ring = 5h account %, centre = today's tokens, swipe for per-device / per-model. | — |

The `/api/report` contract (04) is shared by all phases — keep `v` versioned.
