/**
 * Truncate text to at most `max` characters, marking the cut with an ellipsis.
 *
 * @param text - The text to bound.
 * @param max - Maximum output length in characters, including the `…`.
 * @returns `text` unchanged when within `max`, otherwise its prefix with a
 * trailing `…` so the result stays within `max`.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}
