/**
 * Scores a subsequence match of `term` within `text`.
 *
 * @param text - Candidate text, expected already lower-cased.
 * @param term - Search term, expected already lower-cased.
 * @returns `null` if `term` is not a subsequence of `text`; otherwise a score
 * that rewards consecutive matches (+3) and matches starting a word (+2, a
 * character preceded by `/ - _ .` or a space, or the very first character).
 */
function scoreMatch(text: string, term: string): number | null {
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < text.length && ti < term.length; i++) {
    if (text[i] === term[ti]) {
      let bonus = 1;
      if (i === prev + 1) bonus += 3;
      if (i === 0 || /[/\-_. ]/.test(text[i - 1]!)) bonus += 2;
      score += bonus;
      prev = i;
      ti++;
    }
  }
  return ti === term.length ? score : null;
}

/**
 * Case-insensitive fuzzy subsequence score.
 *
 * @param text - Candidate text.
 * @param term - Search term; an empty term always scores 0.
 * @returns `null` if `term` is not a subsequence of `text`, otherwise a match score.
 */
export function fuzzyScore(text: string, term: string): number | null {
  if (term === "") return 0;
  return scoreMatch(text.toLowerCase(), term.toLowerCase());
}

/**
 * Filters and ranks `items` by fuzzy match against `term`.
 *
 * @param items - Items to filter.
 * @param term - Search term; an empty term returns all items unranked.
 * @param key - Extracts the text to match against from an item.
 * @returns Matching items sorted by descending score, ties broken by original order.
 */
export function fuzzyFilter<T>(items: readonly T[], term: string, key: (item: T) => string): T[] {
  if (term === "") return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const s = fuzzyScore(key(item), term);
    if (s !== null) scored.push({ item, score: s, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}

/**
 * Locates the character positions in `text` that satisfy a fuzzy subsequence
 * match of `term`.
 *
 * @param text - Candidate text.
 * @param term - Search term; an empty term matches with no positions.
 * @returns `null` if `term` is not a subsequence of `text`, otherwise the matched
 * indices into `text`, in order.
 */
export function fuzzyPositions(text: string, term: string): number[] | null {
  if (term === "") return [];
  const t = text.toLowerCase();
  const q = term.toLowerCase();
  const positions: number[] = [];
  let ti = 0;
  for (let i = 0; i < t.length && ti < q.length; i++) {
    if (t[i] === q[ti]) {
      positions.push(i);
      ti++;
    }
  }
  return ti === q.length ? positions : null;
}

/** A contiguous span of text, tagged with whether it was part of a fuzzy match. */
export interface HighlightRun {
  text: string;
  hit: boolean;
}

/**
 * Splits `text` into alternating matched/unmatched {@link HighlightRun}s for rendering.
 *
 * @param text - The text to split.
 * @param positions - Matched character indices (e.g. from {@link fuzzyPositions}), or `null` for no match.
 * @returns Runs covering the whole of `text`, in order.
 */
export function matchRuns(text: string, positions: readonly number[] | null): HighlightRun[] {
  if (!positions || positions.length === 0) return [{ text, hit: false }];
  const set = new Set(positions);
  const runs: HighlightRun[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i]!;
    else runs.push({ text: text[i]!, hit });
  }
  return runs;
}

/**
 * Splits `label` into highlight runs for a fuzzy match against `term`.
 *
 * @param label - The label text.
 * @param term - Search term; an empty term yields a single unmatched run.
 * @returns Highlight runs covering the whole of `label`.
 */
export function labelRuns(label: string, term: string): HighlightRun[] {
  return matchRuns(label, term.length > 0 ? fuzzyPositions(label, term) : null);
}

/** The best-scoring field in a multi-field fuzzy match, and where it matched. */
export interface FieldMatch {
  field: number;
  positions: number[];
}

/**
 * Finds which of several candidate fields best fuzzy-matches `term`.
 *
 * @param fields - Candidate fields to score, e.g. `[label, detail]`.
 * @param term - Search term; an empty term matches nothing.
 * @returns The best-scoring field and its matched positions, or `null` if none match.
 */
export function fuzzyFieldMatch(fields: readonly string[], term: string): FieldMatch | null {
  if (term === "") return null;
  let best: FieldMatch | null = null;
  let bestScore = -1;
  fields.forEach((text, field) => {
    const score = fuzzyScore(text, term);
    if (score === null || score <= bestScore) return;
    const positions = fuzzyPositions(text, term);
    if (!positions) return;
    best = { field, positions };
    bestScore = score;
  });
  return best;
}

/** A fuzzy match against a named field of a listed item (label or detail text). */
export interface ItemMatch {
  field: "label" | "detail";
  positions: number[];
}
