import type { LLMCallResult } from "@clarvis/capability";

/**
 * The shape of a model completion, in priority order: `has-tools` (at least one
 * tool call), `text-only` (assistant text but no tools), `reasoning-only` (only
 * reasoning output), or `empty` (none of the above).
 */
export type ResponseClass = "empty" | "reasoning-only" | "text-only" | "has-tools";

/**
 * Classify a model completion by what it produced, checking tool calls, then
 * text, then reasoning.
 *
 * @param llmResult - the provider call result to inspect.
 * @returns the {@link ResponseClass}; tool calls win over text, text over
 *   reasoning, and an all-empty result yields `"empty"`.
 */
export function classifyResponse(llmResult: LLMCallResult): ResponseClass {
  const hasToolCalls = !!llmResult.toolCalls && llmResult.toolCalls.length > 0;
  if (hasToolCalls) return "has-tools";
  const hasText = !!llmResult.text && llmResult.text.length > 0;
  if (hasText) return "text-only";
  const hasReasoning = !!llmResult.reasoning && llmResult.reasoning.length > 0;
  if (hasReasoning) return "reasoning-only";
  return "empty";
}
