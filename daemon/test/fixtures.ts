export function asst(id: string, out = 10, extra: Record<string, unknown> = {}, model = "claude-sonnet-5-5", ts = "2026-10-01T10:00:00.000Z") {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      id,
      model,
      content: [{ type: "text", text: "SECRET" }],
      usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out, output_tokens_details: { thinking_tokens: 2 } },
    },
    ...extra,
  });
}

