# CLAUDE.md — build instructions

You are building a Chrome MV3 extension described in `docs/`. Read all of `docs/` before coding.

## Stack
- TypeScript, Vite (or plain esbuild) building to `dist/`
- No frameworks in content scripts. Popup may use vanilla TS or Preact (keep bundle small).
- `chrome.storage.local` for persistence. No external servers except the user's DeskBuddy on LAN.

## Rules
1. Never alter claude.ai requests or responses. Observe only (clone streams with `tee()`).
2. Never store or transmit message text. Count characters, then discard.
3. Everything that touches claude.ai internals lives in `src/capture/` behind a parser
   interface, because those endpoints are undocumented and will change.
4. Every parser must fail soft: unknown event shape → log a warning, skip, never throw into the page.
5. Write unit tests for the SSE parser using recorded fixtures in `test/fixtures/`
   (fixtures must have text content replaced with lorem ipsum of equal length).

## Build order
1. Manifest + empty service worker + popup that shows "hello"
2. MAIN-world fetch hook that just logs matching URLs to console
3. SSE parser + fixtures + tests
4. Event bus → service worker → storage
5. Popup stats
6. DeskBuddy sync
7. Account usage poller (/usage endpoint)

## Done means
`npm run build` produces a loadable `dist/`, `npm test` passes, and sending 3 messages on
claude.ai shows 3 messages with the right model in the popup.
