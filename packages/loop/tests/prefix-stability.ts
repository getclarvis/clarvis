import { contentToText } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";

/**
 * Measurement helpers for the one property a provider's implicit prompt cache
 * bills on: the length of the byte-identical **prefix** shared by two successive
 * requests.
 *
 * @remarks An implicit prefix cache (OpenAI, DeepSeek, OpenRouter's upstreams)
 * charges the whole request fresh from the first differing byte onward. So a
 * mutation at position *k* of the message array costs `total - k`, however small
 * the edit itself is, and an append costs nothing. That asymmetry is invisible
 * to an ordinary assertion — a test can check the array *contents* are right and
 * still be enforcing a change that re-charges two thirds of every request.
 *
 * One measured session paid **2,929,430 tokens** — 35.7% of all its uncached
 * input — to a block rewritten in place at 32% of the transcript. These helpers
 * exist so that class of regression fails a test instead of a bill.
 */

/**
 * Render a message array the way a provider sees it for prefix purposes: one
 * record per message, role included, in order.
 *
 * @param messages - the live context's messages.
 * @returns the concatenated rendering; a repositioned message diverges here at
 *   exactly the offset it would diverge at on the wire.
 * @remarks The role is included because moving a `user` block past a `tool`
 *   result changes the wire bytes even when every message's text is unchanged —
 *   which is precisely the relocation this is meant to price.
 */
export function renderForPrefix(messages: readonly LiveMessage[]): string {
  return messages.map((m) => `<${m.role}>${contentToText(m.content)}\n`).join("");
}

/** Characters of common prefix between two renderings. */
function commonPrefixChars(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * The fraction of the earlier rendering that survives as a byte-identical
 * prefix of the later one — i.e. the share of the request a prefix cache can
 * still serve.
 *
 * @param before - the rendering sent last iteration.
 * @param after - the rendering about to be sent.
 * @returns a ratio in `[0, 1]`; `1` means the change was a pure append and
 *   nothing is re-charged, `0` means the entire request is billed fresh.
 */
export function prefixSurvival(before: string, after: string): number {
  if (before.length === 0) return 1;
  return commonPrefixChars(before, after) / before.length;
}
