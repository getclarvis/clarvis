import { countNewlines } from "./text.ts";

/** A half-open character range `[start, end)` into the searched text. */
export interface Span {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * Strip leading and trailing spaces and tabs (but not newlines) from a string.
 *
 * @param s - the string to trim.
 * @returns `s` without surrounding horizontal whitespace.
 */
export const trimEnds = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function lfNormalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimTrailingEmpty(lines: string[]): string[] {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

function endContent(starts: number[], textLen: number, k: number): number {
  return k + 1 < starts.length ? (starts[k + 1] ?? textLen) - 1 : textLen;
}

/**
 * Slide the `need` block across `hay` and collect every starting index where all
 * `need.length` consecutive lines match under `eq`.
 *
 * @param hay - the lines to search within.
 * @param need - the contiguous block of lines to find.
 * @param eq - per-line equality test, called as `eq(hayLine, needLine)`.
 * @param cap - stop after this many hits (default unbounded).
 * @returns the zero-based start indices of each matching window, in order.
 * @remarks Returns empty when `need` is empty or longer than `hay`.
 */
export function scanLineBlocks(
  hay: string[],
  need: string[],
  eq: (hayLine: string, needLine: string) => boolean,
  cap = Infinity,
): number[] {
  const hits: number[] = [];
  if (need.length === 0 || need.length > hay.length) return hits;
  for (let i = 0; i + need.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) {
      if (!eq(hay[i + j] ?? "", need[j] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hits.push(i);
      if (hits.length >= cap) break;
    }
  }
  return hits;
}

function dedentBlock(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const indent = l.length - l.replace(/^[ \t]+/, "").length;
    if (indent < min) min = indent;
  }
  const strip = Number.isFinite(min) ? min : 0;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(strip)));
}

function blockSpan(
  starts: number[],
  textLen: number,
  i: number,
  m: number,
  oldEndsNL: boolean,
): Span {
  const start = starts[i] ?? 0;
  const last = i + m - 1;
  let end = endContent(starts, textLen, last);
  if (oldEndsNL && last + 1 < starts.length) end = starts[last + 1] ?? end;
  return { start, end };
}

function trimmedBoundary(text: string, old: string): Span[] {
  const t = old.trim();
  if (t === old || t === "") return [];
  const spans: Span[] = [];
  let idx = text.indexOf(t);
  while (idx !== -1) {
    spans.push({ start: idx, end: idx + t.length });
    idx = text.indexOf(t, idx + t.length);
  }
  return spans;
}

function indentationFlexible(text: string, old: string, starts: number[]): Span[] {
  const oldLines = trimTrailingEmpty(old.split("\n"));
  const m = oldLines.length;
  const hay = text.split("\n");
  if (m === 0 || m > hay.length) return [];
  const oldD = dedentBlock(oldLines).join("\n");
  const oldEndsNL = old.endsWith("\n");
  const spans: Span[] = [];
  for (let i = 0; i + m <= hay.length; i++) {
    if (dedentBlock(hay.slice(i, i + m)).join("\n") === oldD) {
      spans.push(blockSpan(starts, text.length, i, m, oldEndsNL));
    }
  }
  return spans;
}

function lineTrimmed(text: string, old: string, starts: number[]): Span[] {
  const oldLines = trimTrailingEmpty(old.split("\n"));
  const m = oldLines.length;
  const hay = text.split("\n");
  const need = oldLines.map((l) => l.trim());
  const oldEndsNL = old.endsWith("\n");
  return scanLineBlocks(hay, need, (a, b) => a.trim() === b).map((i) =>
    blockSpan(starts, text.length, i, m, oldEndsNL),
  );
}

function whitespaceNormalized(text: string, old: string, starts: number[]): Span[] {
  const oldLines = trimTrailingEmpty(old.split("\n"));
  const m = oldLines.length;
  const hay = text.split("\n");
  const need = oldLines.map(norm);
  const oldEndsNL = old.endsWith("\n");
  return scanLineBlocks(hay, need, (a, b) => norm(a) === b).map((i) =>
    blockSpan(starts, text.length, i, m, oldEndsNL),
  );
}

function disproportionate(span: Span, text: string, oldLen: number, oldLineCount: number): boolean {
  const slice = text.slice(span.start, span.end);
  const spanLines = countNewlines(slice) + 1;
  if (spanLines >= 2 * oldLineCount) return true;
  if (span.end - span.start - oldLen >= 500) return true;
  return false;
}

function dedupe(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const s of spans) {
    const k = `${s.start}:${s.end}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/**
 * Locate `oldString` inside `text` with progressively looser matching, used to
 * anchor an edit whose whitespace may not exactly match the file.
 *
 * @param text - the document to search.
 * @param oldString - the block to find; its CR/CRLF newlines are normalized to
 *   LF first.
 * @returns the matching {@link Span}s (character ranges into `text`) from the
 *   first tier that produces any, or `null` if no tier matches or `oldString`
 *   normalizes to empty.
 * @remarks Four tiers are tried in decreasing strictness and the first with at
 *   least one surviving span wins: indentation-flexible (dedented block equal),
 *   per-line trimmed, whitespace-normalized, then a trimmed-boundary substring
 *   scan. Within a tier, spans judged disproportionately larger than the source
 *   block are discarded and duplicates are removed, so the returned list may hold
 *   several equally-ranked matches for the caller to disambiguate.
 */
export function findCascadeMatch(text: string, oldString: string): { spans: Span[] } | null {
  const old = lfNormalize(oldString);
  if (old === "") return null;
  const starts = lineStarts(text);
  const oldLineCount = trimTrailingEmpty(old.split("\n")).length;

  const tiers: ((text: string, old: string, starts: number[]) => Span[])[] = [
    indentationFlexible,
    lineTrimmed,
    whitespaceNormalized,
    (t, o) => trimmedBoundary(t, o),
  ];

  for (const tier of tiers) {
    const spans = dedupe(
      tier(text, old, starts).filter((s) => !disproportionate(s, text, old.length, oldLineCount)),
    );
    if (spans.length >= 1) return { spans };
  }
  return null;
}
