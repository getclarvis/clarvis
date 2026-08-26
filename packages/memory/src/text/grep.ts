/**
 * The line-matching half of `MemoryTx.grep`, shared by every backend.
 *
 * Both shipped adapters walk their own storage but must agree exactly on what
 * counts as a match, how a pattern is guarded and where the scan stops — so the
 * decision lives here once rather than being mirrored in each.
 */
import { overlapScore, tokenize } from "./tokenize.ts";

/**
 * Width of one regex window, and the longest slice of a matching line reported
 * back to the caller.
 *
 * @remarks The value is chosen for the clock. The worst pattern
 * {@link isBoundedPattern} still admits, `[a-z]*[a-z]*[a-z]*9`, costs 7 ms over
 * a 100-character line, **100 ms over 200, 1.5 s over 400 and 23 s over 800**
 * (median of three, Bun 1.3.11) — cost is superlinear in the width, so 200 is
 * the last width at which one window fits inside {@link GREP_SCAN_MAX_MS} with
 * room to spare.
 *
 * A long line is therefore matched as a series of these windows
 * ({@link matchWindowed}) rather than truncated to the first one. Truncating
 * bounded the clock by discarding recall: a hit at column 500 stopped matching
 * at all, and since a memory document is prose markdown whose paragraphs are
 * routinely longer than this, that silently hid most of the wiki from a regex
 * search. Windowing keeps the per-`test` input at this width — which is what
 * the measurements above bound — while making the cost of a long line linear in
 * its length instead of superlinear.
 *
 * The keyword path is not windowed: `tokenize` is linear.
 */
export const GREP_LINE_MAX = 200;

/**
 * How much of the previous window each next window repeats.
 *
 * @remarks A window boundary is invisible to the regex engine, so without an
 * overlap a match straddling one would be lost. This is what makes windowing
 * recall-preserving for matches up to this many characters; a match *longer*
 * than this that also straddles a boundary is still missed, and no windowing
 * scheme can find a match longer than a window (`foo.*bar` spanning 900
 * characters is unfindable at any width short of the whole line, which is the
 * cost the clock refuses to pay). Prose search hits are far shorter than this,
 * so the residual is small — and it is bounded and documented, unlike the
 * truncation it replaced.
 *
 * The step is `GREP_LINE_MAX - GREP_WINDOW_OVERLAP`, so this must stay strictly
 * below {@link GREP_LINE_MAX} or the scan would not advance.
 */
export const GREP_WINDOW_OVERLAP = 64;

/**
 * Longest regex pattern the backends will compile.
 *
 * @remarks A pattern longer than this is treated as uncompilable and degrades
 * to the keyword scan, per the port's "regex support is best-effort" contract.
 * It bounds compile cost and how much of a tool argument reaches the engine. It
 * is **not** a defence against catastrophic backtracking, which needs no length
 * at all: `(a+)+$` is six characters and costs ~420 ms on *every* line it is
 * tested against — flat in the line's length, so {@link GREP_LINE_MAX} does not
 * help either, and 200k lines of it is a day of wall clock. Refusing that family
 * outright is {@link isBoundedPattern}'s job.
 */
export const GREP_QUERY_MAX_CHARS = 200;

/**
 * Lines a single `grep` call will examine.
 *
 * @remarks A cap on work, not on time. 200k lines cost whatever the pattern
 * makes them cost: at the admitted per-line worst case of 100 ms that is nearly
 * six hours, so on its own this bounds a pathological pattern's blast radius at
 * "hangs the process for the rest of the day", not at "scans 200k lines and
 * returns what it found". {@link GREP_SCAN_MAX_MS} is what bounds the clock.
 * Reaching either is silent by design — grep is already a best-effort,
 * limit-capped search.
 */
export const GREP_SCAN_MAX_LINES = 200_000;

/**
 * Wall-clock budget for one `grep` call.
 *
 * @remarks The aggregate layer. {@link isBoundedPattern} and
 * {@link GREP_LINE_MAX} together bound one line; only this bounds the scan as a
 * whole, because {@link GREP_SCAN_MAX_LINES} counts lines and a line is not a
 * unit of time. Checked in `ok()`, which every backend consults before each
 * file and each line, so the true ceiling for a call is this budget plus one
 * line's worth of matching.
 */
export const GREP_SCAN_MAX_MS = 2_000;

/**
 * Most `*`, `+`, `?`, `{` and `|` a compiled pattern may carry.
 *
 * @remarks Each one multiplies the ways the engine can split a line, so this
 * caps the degree of the polynomial left over once {@link isBoundedPattern} has
 * removed the exponential families. Three is pinned from both sides. It is the
 * smallest value that still admits `\d{4}-\d{2}-\d{2}`, which carries exactly
 * three; and it is the largest that fits the clock — over a
 * {@link GREP_LINE_MAX}-length line, two markers cost 1.9 ms, three cost 100 ms,
 * and a fourth (`a*a*a*a*b`) costs 2.8 s, more than the entire
 * {@link GREP_SCAN_MAX_MS} budget on one line.
 */
export const GREP_AMBIGUITY_MAX = 3;

/**
 * Decide whether a pattern's worst-case match cost can be bounded.
 *
 * @param pattern - the caller's raw regex source.
 * @returns whether {@link createGrepScanner} may compile it; false sends the
 *   query down the keyword path instead.
 * @remarks One left-to-right pass, deliberately syntactic rather than a parse.
 * It refuses four families, none of which {@link GREP_LINE_MAX} can absorb:
 *
 * - a quantifier applied to a group — `(a+)+$`, `(a|a)*$`, `(\w+)+$`,
 *   `(?:a*)*b` — which is where every exponential case lives;
 * - a backreference (`\1`…`\9`, `\k<name>`), which no linear-time engine
 *   supports and which reintroduces exponential matching by itself;
 * - a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`). `(?<name>` is a *named group*
 *   and is admitted;
 * - more than {@link GREP_AMBIGUITY_MAX} markers, counting `*`, `+`, `?`, `{`
 *   and `|` outside a character class and outside an escape.
 *
 * The first family is the one only this layer can catch, and the reason the
 * line cap is not enough by itself: its cost is **flat in the line's length**.
 * On Bun 1.3.11 `(a+)+$` measures ~420 ms, `(a|a)*$` ~480 ms and `(?:a*)*b`
 * ~1.1 s alike on a 50-character line and on an 800-character one, so
 * truncating the input does nothing and only refusing to compile does. Bun's
 * engine bails out instead of looping forever, which turns the textbook
 * infinite hang into a ~0.5 s tax on each of up to
 * {@link GREP_SCAN_MAX_LINES} lines — a day of wall clock, which is a different
 * shape of the same denial of service, not a mitigation of it.
 *
 * A `?` directly after `(` is the group modifier of `(?:` or `(?<name>`, not a
 * quantifier, and is not counted. Metacharacters inside `[…]` and behind a
 * backslash are literals and are not counted either.
 *
 * The refusal is deliberately blunt in one place: `(foo)?` and `(foo|bar)+` are
 * harmless but are refused with the rest of the quantified-group family, and a
 * five-branch alternation exhausts the marker budget. They degrade to a keyword
 * scan rather than failing, and `grep_memories` names the honoured subset in its
 * `regex` parameter description so a model can tell why its pattern behaved like
 * a keyword search.
 */
export function isBoundedPattern(pattern: string): boolean {
  let markers = 0;
  let inClass = false;
  let prev: "atom" | "open" | "close" = "atom";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && (next === "k" || (next >= "1" && next <= "9"))) return false;
      i += 1;
      prev = "atom";
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      prev = "atom";
      continue;
    }
    if (ch === "(") {
      if (
        pattern.startsWith("(?=", i) ||
        pattern.startsWith("(?!", i) ||
        pattern.startsWith("(?<=", i) ||
        pattern.startsWith("(?<!", i)
      ) {
        return false;
      }
      prev = "open";
      continue;
    }
    if (ch === ")") {
      prev = "close";
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{" || ch === "|") {
      if (ch === "?" && prev === "open") {
        prev = "atom";
        continue;
      }
      if (ch !== "|" && prev === "close") return false;
      markers += 1;
      if (markers > GREP_AMBIGUITY_MAX) return false;
      prev = "atom";
      continue;
    }
    prev = "atom";
  }
  return true;
}

/** A stateful, budget-bounded line matcher for one `grep` call. */
export interface GrepScanner {
  /**
   * Test one line, consuming a unit of the scan budget.
   *
   * @param line - the raw line, untrimmed.
   * @returns whether it matches.
   */
  match(line: string): boolean;
  /**
   * Whether budget remains; a backend must stop walking once this is false.
   *
   * @returns false once either {@link GREP_SCAN_MAX_LINES} lines have been
   *   tested or {@link GREP_SCAN_MAX_MS} of wall clock have passed since the
   *   scanner was built.
   */
  ok(): boolean;
}

/**
 * Build the matcher for one `grep` call.
 *
 * @param query - the caller's pattern or keyword phrase.
 * @param opts.regex - interpret `query` as a case-insensitive regular
 *   expression.
 * @param opts.now - clock the scan deadline is measured against; defaults to
 *   `Date.now`. Injectable so a test can spend the budget without spending the
 *   time.
 * @returns a {@link GrepScanner} whose `match` is true when the regex hits, or —
 *   in keyword mode — when the line shares at least one significant token with
 *   the query. A query that tokenizes to nothing never matches.
 * @remarks Three layers bound what a caller-supplied pattern can cost. They are
 * all needed because neither runtime offers a linear-time engine, and one
 * `RegExp.test` on one line cannot be interrupted once it has started — so a
 * budget consulted between lines, however tight, bounds nothing on its own:
 *
 * 1. {@link isBoundedPattern} decides whether the pattern is compiled at all;
 * 2. {@link GREP_LINE_MAX} bounds the input a single `test` sees — a longer
 *    line is windowed by {@link matchWindowed}, not truncated, so the bound
 *    costs clock rather than recall;
 * 3. {@link GREP_SCAN_MAX_MS} bounds the call as a whole, through `ok()` between
 *    lines and through {@link matchWindowed}'s own check between windows.
 *
 * A pattern refused by layer 1, one longer than {@link GREP_QUERY_MAX_CHARS},
 * and one that simply will not compile all take the same route: `match` falls
 * back to the keyword scan, which is the port's documented "regex support is
 * best-effort" degrade. The caller is not told which of the three happened.
 */
export function createGrepScanner(
  query: string,
  opts: { regex?: boolean; now?: () => number } = {},
): GrepScanner {
  let re: RegExp | null = null;
  if (opts.regex === true && query.length <= GREP_QUERY_MAX_CHARS && isBoundedPattern(query)) {
    try {
      re = new RegExp(query, "i");
    } catch {
      re = null;
    }
  }
  const terms = re === null ? tokenize(query) : null;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let scanned = 0;
  return {
    match(line) {
      scanned += 1;
      if (re !== null) {
        return matchWindowed(re, line, () => now() - startedAt >= GREP_SCAN_MAX_MS);
      }
      return terms !== null && terms.size > 0 && overlapScore(terms, tokenize(line)) > 0;
    },
    ok() {
      return scanned < GREP_SCAN_MAX_LINES && now() - startedAt < GREP_SCAN_MAX_MS;
    },
  };
}

/**
 * Test `re` against `line` in overlapping {@link GREP_LINE_MAX}-wide windows.
 *
 * @param re - the compiled pattern; must not be global or sticky, since this
 *   relies on `test` carrying no `lastIndex` state between windows.
 * @param line - the raw line, of any length.
 * @param spent - consulted after each window; when it returns true the scan of
 *   *this line* stops and reports no match.
 * @returns whether any window matched.
 *
 * @remarks A line no longer than one window is tested whole, which is the
 * overwhelmingly common case and costs exactly what it did before.
 *
 * `spent` is what keeps a long line from swallowing the whole call's budget.
 * One `RegExp.test` cannot be interrupted once started, so the achievable
 * granularity is one window: the true ceiling for a call becomes
 * {@link GREP_SCAN_MAX_MS} plus one window's worth of matching, independent of
 * how long the longest line is. Before windowing that ceiling was the same
 * quantity for a different reason — the line was truncated *to* one window —
 * so bounding the clock costs no recall here, whereas truncating did.
 *
 * Giving up mid-line reports a false negative rather than a partial result,
 * which is consistent with the port's best-effort contract: `ok()` has already
 * gone false by then, so the backend stops and the caller sees a short result
 * for a scan that is over budget either way.
 *
 * **Precision cost.** Each window is its own string, so `^` and `$` anchor to
 * the window rather than to the line, and an anchored pattern can match at a
 * boundary the line does not actually have. Truncation had the same flaw at its
 * single cut point; windowing spreads it across `ceil(len / step)` cut points.
 * That is the deliberate trade: an anchored pattern over an over-long line may
 * over-report, where truncation silently under-reported every pattern.
 */
export function matchWindowed(re: RegExp, line: string, spent: () => boolean): boolean {
  if (line.length <= GREP_LINE_MAX) return re.test(line);
  const step = GREP_LINE_MAX - GREP_WINDOW_OVERLAP;
  for (let start = 0; start < line.length; start += step) {
    if (re.test(line.slice(start, start + GREP_LINE_MAX))) return true;
    if (spent()) return false;
  }
  return false;
}

/**
 * Render a matching line for a hit.
 *
 * @param line - the raw matching line.
 * @returns the line trimmed and capped at {@link GREP_LINE_MAX}.
 * @remarks The excerpt is still capped at one window, so a hit past that offset
 * produces an excerpt that does not contain it. That is a display limit and
 * nothing more: the hit's `path` and `line` are what let the caller open the
 * document, and those are now reported for a match anywhere in the line.
 */
export function grepHitText(line: string): string {
  return line.trim().slice(0, GREP_LINE_MAX);
}
