# 10 - Open questions

Fill in during Phase 0 and 4.

| # | Question | Answer |
|---|---|---|
| 1 | Where does the extension get usage today (page element or endpoint)? Fields and precision? | |
| 2 | Can the sessions list be read (DOM or endpoint)? Is the Current row detectable? | |
| 3 | What exactly makes a session's Updated change (message sent, app opened, token refresh)? | |
| 4 | How long after use does Updated change? | |
| 5 | Do idle sessions change Updated on their own? | |
| 6 | Does Claude Desktop or iOS update its row when used for chat? When used for Claude Code? | |
| 7 | How many physical machines are behind the Claude Desktop rows? | |
| 8 | Are usage % values rounded, and to what precision? | |
| 9 | How soon does the % change after a message (latency)? | |
| 10 | Is polling every 1-2 minutes acceptable and stable? | |
| 11 | Does a re-login always create a new row (so merges are needed)? | |
| 12 | Which permissions does the optional event recorder need, and are they acceptable? | |
| 13 | Single-device test result: share of points credited to the correct device. | |
| 14 | Alternating test result. | |
| 15 | Central store for phase 5: Cloudflare D1 or Supabase? | |

## Accepted limits
- Per-device figures are estimates. Simultaneous use cannot be split exactly.
- Devices without the extension (Claude Desktop, iOS) rely on the Updated signal, which may be coarse.
- Page, endpoint and log formats can change; everything must fail soft and show "could not read".
