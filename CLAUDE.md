# CLAUDE.md — build instructions

This repo holds a Chrome MV3 extension (`src/`), a Claude Code usage daemon (`daemon/`) and, later,
the Usage Hub web app (`hub/`, Next.js on Vercel). Read all of `docs/` before coding;
`docs/04-device-sync.md` is the client/hub contract.

## Stack
- TypeScript, plain esbuild building to `dist/` (extension) and `daemon/dist/` (daemon)
- No frameworks in content scripts. Popup may use vanilla TS or Preact (keep bundle small).
- `chrome.storage.local` for persistence. The only external server is the user's own Usage Hub (HTTPS).

## Rules
1. Never alter claude.ai requests or responses. Observe only (clone streams with `tee()`).
2. Never store or transmit message text. Count characters, then discard.
3. Everything that touches claude.ai internals lives in `src/capture/` behind a parser
   interface, because those endpoints are undocumented and will change.
4. Every parser must fail soft: unknown event shape → log a warning, skip, never throw into the page.
5. Write unit tests for the SSE parser using recorded fixtures in `test/fixtures/`
   (fixtures must have text content replaced with lorem ipsum of equal length).
6. Clients authenticate to the hub with `Authorization: Bearer <token>` only; never log the token.

## Build order
1. Manifest + empty service worker + popup that shows "hello"
2. MAIN-world fetch hook that just logs matching URLs to console
3. SSE parser + fixtures + tests
4. Event bus → service worker → storage
5. Popup stats
6. Hub sync (`src/sync/hub.ts`)
7. Account usage poller (/usage endpoint)

## Done means
`npx tsc --noEmit` and `npm test` pass, `npm run build` produces a loadable `dist/` and
`daemon/dist/claude-usage-daemon.mjs`, `npm run mock` plus `npm run daemon -- once` shows the
devices in `GET /api/state`, and sending 3 messages on claude.ai shows 3 messages with the right
model in the popup.
