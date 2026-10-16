# 11 — Usage Hub (`hub/`)

A small Next.js (App Router, Node runtime) app backed by Neon Postgres. Clients push usage
snapshots (contract: `04-device-sync.md`); the hub shows, for one Claude Pro/Max account, usage
per device x per model with tokens, plus the account's plan limits.

Production: https://claude-usage-hub-three.vercel.app (Vercel project `claude-usage-hub`).

## Routes
| Route | Auth | Notes |
|---|---|---|
| `GET /api/ping` | Bearer | `{ok:true,name:"Claude Usage Hub",v:1}` |
| `POST /api/report` | Bearer | Report v1, <= 64 KB (413), strict validation (400). Older `sentAt` per device is ignored; account snapshot replaced only if `fetchedAt` is newer. |
| `GET /api/state` | Bearer or session | Devices (with `fresh`), fresh-only totals, account, 30-day daily rows. |
| `DELETE /api/devices/[id]` | Bearer or session | Removes the device and its daily history. |
| `/login` | none | Password field = `HUB_TOKEN`. |
| `/` | session | Dashboard; `?w=today|last5h|last7d`. Auto-refresh every 30 s. |

Unauthenticated page requests are redirected to `/login` by `proxy.ts`. All responses are
`{ok:true,...}` / `{ok:false,error}`.

## Dashboard
Plan-limit bars (from the Chrome extension's "Poll account usage"), window tabs, totals
(shown with "≈" when a contributing device is estimated; Claude Code input includes cache reads),
the device x model matrix (stale devices, > 10 min since last report, are dimmed and excluded
from totals), per-model bars, a 30-day stacked daily chart by device (with table view), and a
device list with delete.

## Schema (`hub/db/schema.sql`)
- `devices(device_id pk, device_name, source, estimated, sent_at bigint, received_at timestamptz, windows jsonb)`
- `account_usage(id = 1, fetched_at bigint, windows jsonb, received_at)`
- `daily_usage(device_id, day date, model, messages, tokens, pk(device_id, day, model))` — each report
  upserts `today.byModel` under the day of `sentAt` in `HUB_TZ` (default `UTC`) using `GREATEST`, so
  values never go down within a day.

## Deploy / migrate
```
cd hub
npm install
npm run db:migrate     # uses DATABASE_URL_UNPOOLED from .env.local; idempotent
npm test
vercel deploy --prod   # vercel.json pins framework=nextjs
```
Env vars (Vercel, all environments): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `HUB_TOKEN` (>= 24 chars),
`SESSION_SECRET`, optional `HUB_TZ` (IANA name, e.g. `Asia/Kolkata`). `vercel env pull .env.local` to get them locally.

## Log in
Open the hub URL, enter the `HUB_TOKEN` value. A 30-day httpOnly, Secure, SameSite=Lax cookie
(`<exp>.<HMAC-SHA256(SESSION_SECRET, exp)>`) is set. "Log out" clears it.

## Point clients at it
In the Chrome extension options (or the daemon config) set **Hub URL** = the production URL (no
trailing path) and **Hub token** = `HUB_TOKEN`. Clients send `Authorization: Bearer <token>`.

## Security notes
- Token and cookie MAC comparisons are timing-safe (SHA-256 of both sides, then `timingSafeEqual`).
- Changing `SESSION_SECRET` invalidates all sessions; rotating `HUB_TOKEN` requires updating clients.
- Only aggregates are stored; never message text.
- Bodies are capped at 64 KB (checked on actual length); every field is validated and length-capped.
- The session cookie only authorises dashboard, `/api/state` and device deletion; `/api/report` and
  `/api/ping` need the bearer token.
- No rate limiting in the app; use Vercel Firewall if the URL is exposed to abuse.
