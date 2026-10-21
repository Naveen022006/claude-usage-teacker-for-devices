# 10 - Open questions

Fill in during Phase 0 and 4.

| # | Question | Answer |
|---|---|---|
| 1 | Where does the extension get usage today (page element or endpoint)? Fields and precision? | Endpoint: `GET claude.ai/api/organizations/{orgId}/usage` from the service worker with the browser's sign-in. Fields: `limits[{kind, percent, resets_at, scope.model.display_name}]` (kinds `session`, `weekly_all`, `weekly_scoped`), older shape `five_hour` / `seven_day` with `utilization`, `resets_at`. Parsed into `five_hour`, `seven_day`, `seven_day_<model>`. Precision: not known from code, see Q8. (E1, code reading) |
| 2 | Can the sessions list be read (DOM or endpoint)? Is the Current row detectable? | Yes, by endpoint: `GET /api/auth/sessions/list-active` → `{ data: [{ application_slug, created_at, expires_at, is_current, location_info{}, session_uuid, updated_at, user_agent{} }], pagination{ has_more, limit, offset, total } }`. `is_current` marks this browser. Found with the settings-page shape diagnostic on 2026-10-21 (7 rows = 7 rows in the UI). Inner keys of `user_agent` still to confirm (the reader records them in diagnostics). Settings opens as a modal, so the URL is not always `/settings`. |
| 3 | What exactly makes a session's Updated change (message sent, app opened, token refresh)? | |
| 4 | How long after use does Updated change? | First sign (2026-10-21): the Current Chrome row showed the same Updated (9:52 AM) in two screenshots taken a while apart, so Updated may not move on every message. Needs the E2 test. |
| 5 | Do idle sessions change Updated on their own? | |
| 6 | Does Claude Desktop or iOS update its row when used for chat? When used for Claude Code? | |
| 7 | How many physical machines are behind the Claude Desktop rows? | |
| 8 | Are usage % values rounded, and to what precision? | |
| 9 | How soon does the % change after a message (latency)? | |
| 10 | Is polling every 1-2 minutes acceptable and stable? | Already in use: `/usage` every ~1 min with a claude.ai tab open, every 3 min otherwise, plus +4 s / +20 s after replies. No problems seen so far, but no back-off on HTTP errors yet (add in Phase 1). Sessions read adds one request per poll. (E6, code reading; live stability still to watch) |
| 11 | Does a re-login always create a new row (so merges are needed)? | |
| 12 | Which permissions does the optional event recorder need, and are they acceptable? | None new: it already exists as the MAIN-world fetch hook on `https://claude.ai/*`. |
| 13 | Single-device test result: share of points credited to the correct device. | |
| 14 | Alternating test result. | |
| 15 | Central store for phase 5: Cloudflare D1 or Supabase? | Neither: use the existing Usage Hub (Vercel + Neon). |

## Accepted limits
- Per-device figures are estimates. Simultaneous use cannot be split exactly.
- Devices without the extension (Claude Desktop, iOS) rely on the Updated signal, which may be coarse.
- Page, endpoint and log formats can change; everything must fail soft and show "could not read".
