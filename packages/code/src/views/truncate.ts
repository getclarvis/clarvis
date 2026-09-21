import { glyph } from "../theme/glyphs.ts";

/** Wraps a reasoning preview by terminal cells, retaining at most three visible lines. */
export function thinkingPreview(text: string, columns: number): string {
  const width = Math.max(3, Math.floor(columns));
  const lines: string[] = [];
  let line = "";
  const push = (): boolean => {
    lines.push(line.trimEnd());
    line = "";
    return lines.length === 3;
  };
  const shortened = (): string => {
    let last = lines[2] ?? "";
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(last),
    ].map((entry) => entry.segment);
    while (Bun.stringWidth(last) > width - 3) {
      segments.pop();
      last = segments.join("");
    }
    lines[2] = last.trimEnd() + "...";
    return lines.join("\n");
  };
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const token of text.matchAll(/\n|[^\S\n]+|[^\s]+/gu)) {
    const word = token[0];
    if (word === "\n") {
      if (push()) return shortened();
      continue;
    }
    if (line && Bun.stringWidth(line + word) > width) {
      if (push()) return shortened();
      if (word.trim() === "") continue;
    }
    for (const { segment } of graphemes.segment(word)) {
      if (Bun.stringWidth(line + segment) > width) {
        if (push()) return shortened();
      }
      line += segment;
    }
  }
  lines.push(line.trimEnd());
  return lines.join("\n");
}

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
 * Characters a wrapped line prefers to break after, so a path or a word stays as
 * close to whole as the cell budget allows.
 */
const BREAK_CHARS = new Set(["/", "\\", "-", "_", ".", " "]);

/**
 * Where to break a full line when the next grapheme no longer fits.
 *
 * @param parts - the graphemes currently on the line.
 * @param limit - the line's cell budget.
 * @returns the number of graphemes to keep, or `null` for a hard break.
 */
function breakAt(parts: readonly string[], limit: number): number | null {
  const floor = Math.max(1, Math.floor(limit / 4));
  let cut: number | null = null;
  let cells = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    cells += Bun.stringWidth(part);
    if (cells >= floor && BREAK_CHARS.has(part)) cut = index + 1;
  }
  return cut;
}

/**
 * Lays text out as lines that each fit a cell budget, breaking rather than abbreviating.
 *
 * @param text - the text to lay out; `null`/`undefined` lays out as one empty line.
 * @param width - the cell budget per line, at least 1.
 * @returns one entry per painted line, in reading order.
 * @remarks Graphemes are never split, so a name with no separator at all — a
 *   minified bundle, a deep path — still lays out inside its panel instead of
 *   being abbreviated away. A break prefers the last separator past a quarter of
 *   the budget, which is what keeps `nome-completo-do-arquivo.test.ts` readable;
 *   an explicit `\n` always starts a new line. Nothing is dropped, so a caller
 *   renders the whole identity and pays for it in height.
 */
export function wrapCells(text: string | undefined | null, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const lines: string[] = [];
  for (const paragraph of (text ?? "").split("\n")) {
    let parts: string[] = [];
    const cells = (): number => Bun.stringWidth(parts.join(""));
    for (const { segment } of graphemes.segment(paragraph)) {
      if (parts.length > 0 && cells() + Bun.stringWidth(segment) > limit) {
        const cut = breakAt(parts, limit);
        if (cut === null) {
          lines.push(parts.join(""));
          parts = [segment];
        } else {
          lines.push(parts.slice(0, cut).join(""));
          parts = [...parts.slice(cut), segment];
        }
        continue;
      }
      parts.push(segment);
    }
    lines.push(parts.join(""));
  }
  return lines;
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
