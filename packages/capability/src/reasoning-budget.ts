import type { ReasoningEffort } from "./api.ts";
import type { ResolvedProviderConfig } from "./llm-port.ts";

/**
 * Approximate output-token headroom to reserve above a configured
 * `maxOutputTokens` per effort level, so an Anthropic response still has room
 * to land after the model spends part of its budget thinking.
 *
 * @remarks A local safety margin only. The actual thinking depth is decided by
 *   Anthropic's own effort/adaptive-thinking mechanism (see
 *   `buildCallTuning` in `./ai-sdk-adapter.js`), not by a token count Clarvis
 *   picks — these numbers never reach the provider.
 */
const ANTHROPIC_OUTPUT_HEADROOM_TOKENS: Record<Exclude<ReasoningEffort, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};
const ANTHROPIC_ANSWER_HEADROOM_TOKENS = 8192;

/**
 * The minimum `maxOutputTokens` a call needs so an Anthropic response has room
 * to land after the model spends part of its budget thinking, for a given
 * provider kind and reasoning effort.
 *
 * @param kind - the resolved provider kind, when known.
 * @param effort - the requested reasoning effort, when set.
 * @returns the floor in tokens, or `undefined` when no floor applies (any
 *   non-anthropic kind, no effort requested, or effort `"off"`).
 * @remarks Shared between `ai-sdk-adapter.ts` (which applies the floor to the
 *   call it builds) and the loop's window-aware `clampOutputBudget` (which
 *   must raise a budget toward this floor and *then* clamp the result to the
 *   model's actual context window — raising first and clamping only inside
 *   the adapter would let a large floor (e.g. `xhigh`/`max`) push
 *   `maxOutputTokens` past the window on a near-full context, which the
 *   provider would reject outright).
 */
export function reasoningOutputFloor(
  kind: ResolvedProviderConfig["kind"] | undefined,
  effort: ReasoningEffort | undefined,
): number | undefined {
  if (kind !== "anthropic" || effort === undefined || effort === "off") return undefined;
  return ANTHROPIC_OUTPUT_HEADROOM_TOKENS[effort] + ANTHROPIC_ANSWER_HEADROOM_TOKENS;
}
