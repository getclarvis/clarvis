import { glyph } from "../theme/glyphs.ts";

/**
 * Truncates `s` to at most `max` characters, dropping the end and appending
 * an ellipsis glyph.
 *
 * @param s - The string to truncate. A nullish value is treated as `""`, so a
 * config field the user has cleared cannot throw out of a render pass.
 * @param max - The maximum length of the result, in characters.
 * @returns `s` unchanged if it already fits; otherwise a truncated prefix
 * ending in the ellipsis glyph. Returns `""` for `max <= 0`, and falls back
 * to a truncated ellipsis itself if `max` is too small to fit any of `s`.
 */
export function truncateEnd(s: string | undefined | null, max: number): string {
  if (max <= 0) return "";
  if (s == null) return "";
  if (s.length <= max) return s;
  const ell = glyph("ellipsis");
  if (max <= ell.length) return ell.slice(0, max);
  return s.slice(0, max - ell.length) + ell;
}

/**
 * Truncates `s` to at most `max` characters, dropping the start and
 * prepending an ellipsis glyph.
 *
 * @param s - The string to truncate. A nullish value is treated as `""`, so a
 * config field the user has cleared cannot throw out of a render pass.
 * @param max - The maximum length of the result, in characters.
 * @returns `s` unchanged if it already fits; otherwise a truncated suffix
 * prefixed with the ellipsis glyph. Returns `""` for `max <= 0`, and falls
 * back to a truncated ellipsis itself if `max` is too small to fit any of `s`.
 */
export function truncateStart(s: string | undefined | null, max: number): string {
  if (max <= 0) return "";
  if (s == null) return "";
  if (s.length <= max) return s;
  const ell = glyph("ellipsis");
  if (max <= ell.length) return ell.slice(0, max);
  return ell + s.slice(s.length - (max - ell.length));
}

/**
 * Formats a count for compact display, abbreviating thousands with a `k`
 * suffix.
 *
 * @param n - The count to format.
 * @returns `n` as-is below 1000; otherwise `n` divided by 1000 with one
 * decimal place (none from 10000 up) and a trailing `k`, e.g. `"1.2k"` or
 * `"12k"`.
 */
export function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/**
 * Formats the "more lines hidden" chip shown when a block is folded.
 *
 * @param hidden - The number of lines hidden from view.
 * @returns The ellipsis glyph followed by the hidden line count, pluralized
 * correctly for `hidden === 1`.
 */
export function moreChip(hidden: number): string {
  return `${glyph("ellipsis")} +${hidden} line${hidden === 1 ? "" : "s"}`;
}

/**
 * Lays a value out as a fixed-width column that can never touch the next one.
 *
 * @param value - the cell's text. A nullish value is treated as `""`.
 * @param width - the column width, in characters.
 * @returns `value` padded to `width`, or `value` plus a single space when it is
 * already at least that long.
 * @remarks `padEnd` alone adds nothing once the value reaches the width, so an
 * overflowing label ran straight into the description beside it —
 * `sessions > Export transcriptWrite the transcript to a file`, reproducible at
 * full width, in Help's "Go to" rows, the Manual bindings list and elsewhere.
 * A column whose content is not itself truncated has to guarantee the gap.
 */
export function padColumn(value: string | undefined | null, width: number): string {
  const text = value ?? "";
  return text.length >= width ? `${text} ` : text.padEnd(width);
}
