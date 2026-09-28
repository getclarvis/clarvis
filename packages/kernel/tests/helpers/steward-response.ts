import type { LLMCallResult } from "@clarvis/capability";

/** Deterministic Steward response for transport fixtures that test the surrounding host. */
export function stewardResponse(
  messages: readonly { role: string; content?: unknown }[],
): LLMCallResult {
  const frame = JSON.parse(
    String(messages.findLast((message) => message.role === "user")?.content),
  ) as {
    mode?: string;
  };
  const result = {
    verdict: frame.mode === "definition" ? "accept_definition" : "achieved",
    message: "Fixture result observed",
  };
  return {
    toolCalls: [{ id: "steward-result", name: "submit_result", arguments: result }],
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
  };
}
