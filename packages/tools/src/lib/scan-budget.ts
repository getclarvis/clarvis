/**
 * A per-call allowance of regular-expression time, charged by the in-process
 * scanners so a hostile pattern cannot freeze the single-threaded host.
 *
 * @remarks
 * The unbounded axis is the *number* of regex applications, not the cost of one.
 * Measured on this repository's runtime (Bun 1.3.11, JavaScriptCore/Yarr), a
 * single match operation is already capped by the engine's own backtracking
 * limit: `((a+)+)+$` against 30 `a`s costs ~1.96 s, and so does the same pattern
 * against 50,000 `a`s or with two further levels of nesting. A global
 * `match()`/`matchAll()` over many pathological segments is one such operation,
 * also ~2 s. Five sequential `test()` calls, however, cost ~9.85 s — the cost
 * accumulates once per application. That is what makes the scanners dangerous:
 * grep's in-process path applies the pattern once per *line* and `replace` once
 * per *file*, so a 200,000-line tree costs ~111 hours and a 5,000-file tree
 * ~5.5 hours, with no way to preempt it (an `AbortSignal` cannot interrupt
 * synchronous CPU-bound work already in flight).
 *
 * Capping the pattern's *length* would defend against none of this — `(a|a)+$`
 * is seven characters and `(a*)*b` is six — and capping the number of lines
 * bounds memory and I/O rather than the hazard. Time is the only unit that
 * measures it, and the place to spend the check is between applications.
 *
 * Only regex time is charged: never a `stat`, never a read, never the directory
 * walk. A slow disk, a cold cache or unrelated work between applications
 * therefore cannot exhaust a budget. Scheduler time spent while an application
 * is in flight is still part of that application's elapsed cost. A plain
 * pattern applied to 200,000 lines charges 5-7 ms in total — not zero, because
 * `Date.now()`'s one-millisecond granularity rounds a share of the individual
 * charges up, so the accounting tracks the run's real elapsed cost rather than
 * undercounting it.
 *
 * The residual is the budget plus one in-flight application, because a check can
 * only happen between applications. On a JavaScriptCore host that residual is
 * bounded at roughly two seconds by the engine; on a runtime whose regex engine
 * does not cap backtracking, that one application is unbounded and this guard
 * cannot preempt it.
 */
export interface ScanBudget {
  /**
   * Run `run`, charging its wall-clock duration against the budget.
   *
   * @param run - the regex application to time; it is always executed, even
   *   once the budget is exhausted, so callers decide what to skip.
   * @returns whatever `run` returned, unchanged.
   */
  charge<T>(run: () => T): T;

  /** Whether the charged time has reached or passed the budget. */
  exhausted(): boolean;
}

/**
 * Create a {@link ScanBudget} allowing `budgetMs` milliseconds of regex time.
 *
 * @param budgetMs - the allowance in milliseconds; the product default is
 *   `DEFAULT_REGEX_SCAN_BUDGET_MS`, resolved onto
 *   `RuntimeConfig.regexScanBudgetMs`.
 * @param now - wall clock used for accounting; injectable for deterministic
 *   tests, and `Date.now` in production.
 * @returns a fresh budget with nothing charged against it yet.
 */
export function createScanBudget(budgetMs: number, now: () => number = Date.now): ScanBudget {
  let spent = 0;
  return {
    charge<T>(run: () => T): T {
      const started = now();
      const value = run();
      spent += now() - started;
      return value;
    },
    exhausted(): boolean {
      return spent >= budgetMs;
    },
  };
}
