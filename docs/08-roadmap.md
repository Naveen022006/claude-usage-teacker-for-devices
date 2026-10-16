# 08 — Roadmap

| Phase | Client | How usage is measured | Accuracy |
|---|---|---|---|
| 1 | Chrome extension (this) | Observe claude.ai streams | Estimated |
| 2 | Claude Code terminal | Node daemon `daemon/` tails local transcripts (exact `usage`) and posts `source:"claude-code"`, `estimated:false` reports. See docs/09-claude-code-daemon.md. | Exact |
| 3 | Claude Desktop app | No extension API. Options: (a) desktop app MCP server can't see usage; (b) proxy/inspect is fragile. Likely show "account usage minus known devices" as "other". | Approx / derived |
| 4 | DeskBuddy firmware | Merge reports per device, round UI on 1.43" AMOLED: ring = 5h account %, centre = today's tokens, swipe for per-device / per-model. | — |

The `/api/report` contract (04) is shared by all phases — keep `v` versioned.
