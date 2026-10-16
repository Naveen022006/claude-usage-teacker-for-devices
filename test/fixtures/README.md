# Fixtures

These `.sse` files are **synthetic**: modelled on the Anthropic Messages streaming format,
not recorded from claude.ai. Replace them with real recordings (DevTools -> Network ->
completion request -> copy response) with every text value replaced by lorem ipsum of the
**same length**, per docs/07-testing.md. Tests assert the char counts below, so update the
expectations when swapping files.

- normal.sse: output 56 chars
- thinking.sse: thinking 71 chars, output 27 chars
- error.sse: error event halfway (output 17 chars)
- limit.sse: contains a `message_limit` event
- unknown-events.sse: unknown event names and one malformed JSON data line (output 17 chars)
