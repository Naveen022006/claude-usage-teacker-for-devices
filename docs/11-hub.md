# 11 — Usage Hub (`hub/`)

An API-only Next.js (App Router, Node runtime) backend on Neon Postgres. There is **no web front
end**: the only UI is the widget the Chrome extension injects into claude.ai, which calls the hub
from the extension service worker (host permission; no CORS headers are sent). Clients push usage
snapshots (contract: `04-device-sync.md`); the hub stores them per device x per model.

Production: https://claude-usage-hub-three.vercel.app (Vercel project `claude-usage-hub`).

## Routes
All API routes need `Authorization: Bearer <HUB_TOKEN>` (401 otherwise). Responses are
`{ok:true,...}` / `{ok:false,error}`, `Cache-Control: no-store`. No cookies, sessions or CORS.
| Route | Notes |
|---|---|
| `GET /` | No auth. `{"name":"Claude Usage Hub","ok":true}`. |
| `GET /api/ping` | `{ok:true,name:"Claude Usage Hub",v:1}` |
| `POST /api/report` | Report v1, <= 64 KB (413), strict validation (400). Older `sentAt` per device is ignored; account snapshot replaced only if `fetchedAt` is newer. |
| `GET /api/state` | See below. |
| `DELETE /api/devices/[id]` | Removes the device and its daily history (404 if unknown). |
Any other path (e.g. `/login`) is 404.

### `GET /api/state` response
```
{ ok:true, now:<ms>,
  devices:[{ deviceId, deviceName, source, estimated, sentAt, receivedAt, fresh,
             windows:{ today|last5h|last7d: { messages, promptTokens, outputTokens,
                                              byModel:{ <model>:{messages,tokens} } } } }],
  totals:{ today, last5h, last7d },   // same window shape, summed over fresh devices only
  account: null | { fetchedAt, receivedAt, windows:{...plan limits...} },  // newest snapshot
  daily:[{ deviceId, day:"YYYY-MM-DD", model, messages, tokens }] }          // last 30 days
```
`fresh` = last report received <= 10 min ago. Shape is unchanged from the former dashboard-era
API (the `daily` history is kept for a future widget view).

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
optional `HUB_TZ` (IANA name, e.g. `Asia/Kolkata`). `vercel env pull .env.local` to get them locally.
(`SESSION_SECRET` was removed along with the dashboard.)

## Point clients at it
In the Chrome extension options (or the daemon config) set **Hub URL** = the production URL (no
trailing path) and **Hub token** = `HUB_TOKEN`. Clients send `Authorization: Bearer <token>`.

## Security notes
- Token comparison is timing-safe (SHA-256 of both sides, then `timingSafeEqual`).
- Rotating `HUB_TOKEN` requires updating clients.
- Only aggregates are stored; never message text.
- Bodies are capped at 64 KB (checked on actual length); every field is validated and length-capped.
- No rate limiting in the app; use Vercel Firewall if the URL is exposed to abuse.
