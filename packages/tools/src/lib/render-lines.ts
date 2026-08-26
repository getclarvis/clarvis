const MAX_LINE = 2000;
const LINE_TRUNC = " [... line truncated ...]";

function capBytes(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  const room = Math.max(0, maxBytes - Buffer.byteLength(LINE_TRUNC, "utf8"));
  const buf = Buffer.from(content, "utf8");
  let end = Math.min(room, buf.length);
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + LINE_TRUNC;
}

/** The result of rendering a numbered line slice (see {@link renderNumberedSlice}). */
export interface RenderedSlice {
  /** The rendered rows joined by `\n`, each prefixed with a padded 1-based line number and a tab. */
  body: string;
  /** How many lines were actually included. */
  shownLines: number;
  /** True when the byte budget stopped the slice before `hardEnd` was reached. */
  byteCapped: boolean;
}

/**
 * Render lines `[start, hardEnd)` as a numbered, `cat -n`-style block, bounded by
 * a byte budget and with over-long lines truncated.
 *
 * @param lines - the full array of source lines (0-based).
 * @param start - the first line index to render.
 * @param hardEnd - one past the last line index to consider.
 * @param maxBytes - the total byte budget for the rendered block.
 * @returns a {@link RenderedSlice}: the joined body, the count of lines shown, and
 *   whether the budget cut the slice short.
 * @remarks Each row is `<6-wide line number>\t<content>`. A line longer than
 *   `MAX_LINE` (2000) chars is clipped (respecting a surrogate pair) and marked,
 *   and any single row is byte-capped to fit the budget. At least the `start`
 *   line is always emitted; subsequent lines stop once the running byte total
 *   would exceed `maxBytes`, setting `byteCapped`.
 */
export function renderNumberedSlice(
  lines: string[],
  start: number,
  hardEnd: number,
  maxBytes: number,
): RenderedSlice {
  const out: string[] = [];
  let used = 0;
  let end = start;
  for (let i = start; i < hardEnd; i++) {
    let content = lines[i] ?? "";
    if (content.length > MAX_LINE) {
      let cut = MAX_LINE;
      const code = content.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      content = content.slice(0, cut) + LINE_TRUNC;
    }
    const prefix = `${String(i + 1).padStart(6)}\t`;
    content = capBytes(content, maxBytes - Buffer.byteLength(prefix, "utf8") - 1);
    const row = prefix + content;
    const rowBytes = Buffer.byteLength(row, "utf8") + 1;
    if (i > start && used + rowBytes > maxBytes) break;
    out.push(row);
    used += rowBytes;
    end = i + 1;
  }
  return { body: out.join("\n"), shownLines: end - start, byteCapped: end < hardEnd };
}
