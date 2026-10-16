# 07 — Testing

## Unit (vitest)
- `sse.ts`: split chunks mid-line, mid-event, CRLF, empty data, comment lines.
- `claudeParser.ts`: recorded fixtures → expected UsageEvent; unknown events ignored;
  stream that errors halfway → `status: "error"`.
- Aggregates: window boundaries, by-model grouping, 30-day pruning.

## Recording fixtures
DevTools → Network → completion request → copy response. Replace every text value with
lorem ipsum of the **same length** (so char counts stay valid). Save as `test/fixtures/<name>.sse`.
Record: normal reply, extended thinking, retry, aborted (stop button), error.

## Manual
1. Load `dist/` unpacked. Send 3 messages with 2 different models → popup shows 3 msgs, right models.
2. Press Stop mid-reply → event `aborted`.
3. Reload tab mid-stream → no page errors in console.
4. ESP32 off → sync dot red; turn on → green within 60 s.

## Calibrating chars-per-token
Use the API's token counting endpoint (or the Claude Code transcripts in phase 2, which have
exact counts) on ~20 sample texts of your typical content, compute chars/tokens, set default.
