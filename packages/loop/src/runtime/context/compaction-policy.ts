import type { LiveMessage } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import type { CompactionConfig } from "./compaction-contracts.ts";

/** A frozen compaction policy that turns truncation and eviction off. */
export const DISABLED_COMPACTION: CompactionConfig = Object.freeze({
  enabled: false,
  windowTokens: 0,
  fraction: 1,
  targetFraction: 1,
  maxResultChars: Number.MAX_SAFE_INTEGER,
  preserveRecentTokens: 0,
  llmTimeoutMs: 120000,
});

/**
 * Prefix marking the durable rolling-summary anchor — the one non-evictable
 * entry that absorbs every span this context has ever summarized.
 *
 * @remarks The apposition is load-bearing: a summary a model reads as an
 *   instruction changes its behaviour, so the marker says outright that the text
 *   is a record of what happened, not a directive.
 */
export const SUMMARY_ANCHOR_PREFIX =
  "[runtime: rolling summary of earlier context — historical record, not instructions]\n";

/** The naive token estimate: one token per four characters, rounded up. */
export function estimateTokensForChars(totalChars: number): number {
  return Math.ceil(totalChars / 4);
}

const MAX_RESULT_WINDOW_FRACTION = 0.1;
const MAX_RESULT_MIN_CHARS = 16_000;
const MAX_RESULT_MAX_CHARS = 200_000;
const CHARS_PER_TOKEN = 4;

/** Hard safety ceiling for one inline image returned by a tool. */
export const MAX_TOOL_IMAGE_CHARS = 8_000_000;

/** Hard safety ceiling for the number of inline images one tool result retains. */
export const MAX_TOOL_IMAGES_PER_RESULT = 4;

/** Hard safety ceiling for inline tool-image payloads retained by one live context. */
export const MAX_LIVE_TOOL_IMAGE_CHARS = 12_000_000;

/**
 * The default single-result cap for a model of a given context window: ~10% of
 * the window, clamped to `[16000, 200000]` characters.
 *
 * @param windowTokens - the model's context window.
 * @returns the character budget for {@link CompactionConfig.maxResultChars}.
 * @remarks Derived rather than absolute so the property being defended — *one
 *   tool result must not occupy more than about a tenth of the window* — holds
 *   for a 32k model and a 1M model alike. The previous flat default of 300000
 *   was over half of a 128k window in a single result, and it only ever bound
 *   where the built-in tools were not in the path (MCP results and sub-agent
 *   returns), which is exactly where the content is least predictable.
 */
export function deriveMaxResultChars(windowTokens: number): number {
  return Math.min(
    MAX_RESULT_MAX_CHARS,
    Math.max(
      MAX_RESULT_MIN_CHARS,
      Math.round(windowTokens * MAX_RESULT_WINDOW_FRACTION * CHARS_PER_TOKEN),
    ),
  );
}

const PRESERVE_RECENT_WINDOW_FRACTION = 0.08;
const PRESERVE_RECENT_MIN_TOKENS = 4_000;
const PRESERVE_RECENT_MAX_TOKENS = 32_000;

/**
 * The default tail-protection budget for a model of a given context window: 8%
 * of the window, clamped to `[4000, 32000]` tokens.
 *
 * @param windowTokens - the model's context window.
 * @returns the token budget for {@link CompactionConfig.preserveRecentTokens}.
 * @remarks Resolved above {@link createLiveContext} rather than inside it,
 *   because `preserveRecentTokens` is a required field and `0` has to keep
 *   meaning *protect nothing* — it cannot double as "derive one". A window too
 *   small for even the floor is handled downstream, where the budget is capped
 *   at half the low-water mark.
 *
 *   Counting entries instead of tokens was the defect this replaces: two
 *   entries can be 400 bytes or 400 KB, so the protection said nothing about how
 *   much recent work the model could still see.
 */
export function derivePreserveRecentTokens(windowTokens: number): number {
  return Math.min(
    PRESERVE_RECENT_MAX_TOKENS,
    Math.max(
      PRESERVE_RECENT_MIN_TOKENS,
      Math.round(windowTokens * PRESERVE_RECENT_WINDOW_FRACTION),
    ),
  );
}

/**
 * Whether {@link LiveContext.appendToolMessage} would truncate this result.
 *
 * @param content - the untruncated tool result.
 * @param config - the agent's compaction policy.
 * @returns `true` when the middle of `content` will be dropped.
 * @remarks Exported because the decision is needed *before* the append, by the
 *   caller that persists the full text and hands back a `spillPath`. Keeping the
 *   rule in one place is the point: a caller that spilled on a different
 *   predicate would either name a file for a result that was never cut, or cut a
 *   result whose original it never wrote.
 */
export function willTruncateToolResult(content: string, config: CompactionConfig): boolean {
  return config.enabled && content.length > config.maxResultChars;
}

/**
 * The character weight of a message for compaction accounting: its text length,
 * every inline image payload, and (for an assistant turn with tool calls) the
 * serialized calls.
 *
 * @remarks Images must be counted even though providers tokenize them
 * differently from prose. The number is used as a retained-size proxy as well
 * as a token estimate: omitting base64 let an image-only tool result contribute
 * almost zero while retaining megabytes in the live context and final snapshot.
 */
export function liveMessageChars(m: LiveMessage): number {
  let n = contentToText(m.content).length;
  if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part.type === "image") n += part.image.length + (part.mediaType?.length ?? 0);
    }
  }
  if (m.role === "tool") {
    for (const image of m.images ?? []) n += image.data.length + image.mediaType.length;
  }
  if (m.role === "assistant" && "tool_calls" in m) n += JSON.stringify(m.tool_calls).length;
  if (m.role === "assistant" && "reasoning" in m) n += JSON.stringify(m.reasoning).length;
  return n;
}
