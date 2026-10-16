# 02 — Data capture

> claude.ai's API is **undocumented and changes without notice**. Every endpoint and event
> name below must be verified in DevTools → Network before coding, and re-checked when
> capture breaks. Keep all of this inside `src/capture/`.

## 1. What to intercept
In DevTools on claude.ai, send a message and find the streaming request. Historically it looks like:

```
POST /api/organizations/{orgId}/chat_conversations/{convId}/completion
Content-Type: text/event-stream (response)
```
Also watch for `retry_completion` (regenerate) and any `/completion` variant used by
Projects. Match with a regex, not an exact string:
`/\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/(retry_)?completion/`

## 2. How to intercept (MAIN world)
```ts
const orig = window.fetch;
window.fetch = async (...args) => {
  const res = await orig(...args);
  try {
    if (isCompletion(args) && res.body) {
      const [forPage, forUs] = res.body.tee();
      parseStream(forUs, requestMeta(args)); // async, never awaited by the page
      return new Response(forPage, res);      // keep status/headers
    }
  } catch (e) { console.warn("[deskbuddy]", e); }
  return res;
};
```
- Run at `document_start` so the hook exists before the app's first fetch.
- From the **request body** (JSON) read: `model` (if present), prompt length in chars,
  attachment count. Do not keep the text.
- Never let a parser error reach the page.

## 3. What to read from the stream
Parse SSE (`event:` / `data:` lines, blank line = end of event). Typical events to look for:

| Event (verify!) | Use |
|---|---|
| `message_start` | `message.model` → model id, `message.id` |
| `content_block_delta` | sum `delta.text` length (output chars); thinking deltas counted separately |
| `message_delta` / `message_stop` | end of message, stop reason |
| `message_limit` (or similar) | rate-limit info — store as account hint |
| `error` | mark event as failed |

If no model is found in the stream, fall back to the model in the request body, then to `"unknown"`.

## 4. Account usage (optional, step 7)
The Settings → Usage page reads an endpoint like `GET /api/organizations/{orgId}/usage`
returning utilisation % and reset times per window. Verify the exact path and shape.
The service worker may poll it every 5 min **only while a claude.ai tab is open**
(`credentials: "include"`, host permission for claude.ai). orgId comes from the
captured completion URL.

## 5. Token estimation
The web stream does not reliably give token counts, so estimate:
```
tokens ≈ ceil(chars / 3.6)   // tune with 07-testing
```
- `inputTokens` = this prompt's chars only (we can't see the full conversation context
  the server sends to the model, so label it "prompt tokens", not true input tokens).
- `outputTokens` = response chars (+ thinking chars, tracked separately).
- Store `estimated: true` on every web event.

Never present these as exact. The UI says "≈".
