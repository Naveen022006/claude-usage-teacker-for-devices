# 08 — Roadmap

| Phase | Component | How usage is measured | Accuracy | Status |
|---|---|---|---|---|
| 1 | Chrome extension (`src/`) | Observe claude.ai streams | Estimated | ✅ |
| 2 | Claude Code daemon (`daemon/`) | Tails local transcripts (exact `usage`), posts `source:"claude-code"`, `estimated:false`. See docs/09. | Exact | ✅ |
| 3 | Claude Desktop (Code sessions) | Same daemon; transcript `entrypoint:"claude-desktop"` -> separate `source:"desktop"` device. Desktop chat writes nothing locally (account limits only). See docs/10. | Exact (Code sessions) | ✅ |
| 4 | Usage Hub (`hub/`, Next.js on Vercel) | Receives all reports, merges per device x model, shows tokens and plan limits behind a token login. | — | ⏳ |

The `/api/report` contract (04) is shared by all phases — keep `v` versioned.
