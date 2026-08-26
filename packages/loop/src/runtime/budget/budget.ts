import type { LLMUsage } from "@clarvis/capability";
import type { TokenCounts } from "@clarvis/capability";

/**
 * Outcome of a hard-limit check: non-terminal, or terminal with the dimension
 * (`"iterations"` or `"tokens"`) that was hit.
 */
export type BudgetCheckResult =
  { terminal: false } | { terminal: true; reason: "iterations" | "tokens" };

/**
 * Running tally of token spend against a hard cap.
 *
 * @remarks Consumption is billed as non-cached input plus output
 * (`max(0, input - cached) + output`). Provider adapters normalize
 * `input_tokens` to the full prompt size, so cache **writes** already sit
 * inside it and count toward the cap at 1x — do not add `cache_write` to
 * {@link TokenLedger.consumed}, which would double-count them. Anthropic prices
 * writes at 1.25x (5m) or 2x (1h), but this ledger caps tokens rather than
 * spend, so no provider-specific weighting belongs here. Cache **reads** are
 * subtracted back out and do not count. Both are tracked in
 * {@link TokenLedger.totals} regardless.
 */
export interface TokenLedger {
  /** Tokens left before the cap (may go negative once exceeded). */
  remaining(): number;
  /** Whether adding `projected` more consumed tokens would reach or exceed the cap. */
  wouldExceed(projected: number): boolean;
  /** Fold one call's usage into the running totals. */
  consume(u: LLMUsage): void;
  /** Consumed tokens counting toward the cap. */
  consumed(): number;
  /** The raw input/output/cached/cache-write breakdown. */
  totals(): TokenCounts;
}

/**
 * Create a {@link TokenLedger} that caps consumption at `maxTokens`.
 *
 * @param maxTokens - the hard token budget for the run.
 * @returns a fresh ledger starting at zero on every dimension.
 */
export function createTokenLedger(maxTokens: number): TokenLedger {
  let input = 0;
  let output = 0;
  let cached = 0;
  let cache_write = 0;
  const consumed = (): number => Math.max(0, input - cached) + output;
  return {
    remaining(): number {
      return maxTokens - consumed();
    },
    wouldExceed(projected: number): boolean {
      return consumed() + projected >= maxTokens;
    },
    consume(u: LLMUsage): void {
      input += u.input_tokens;
      output += u.output_tokens;
      cached += u.cached_tokens;
      cache_write += u.cache_write_tokens;
    },
    consumed,
    totals(): TokenCounts {
      return { input, output, cached, cache_write };
    },
  };
}

/** Counts loop iterations against a hard cap. */
export interface IterationCounter {
  /** Mark the start of a new iteration (increments the count). */
  start(): void;
  /** Whether the count has reached the cap. */
  atCap(): boolean;
  /** Iterations started so far. */
  count(): number;
}

/**
 * Create an {@link IterationCounter} that reports `atCap` once `maxIterations`
 * iterations have started.
 *
 * @param maxIterations - the hard iteration budget for the run.
 * @returns a fresh counter starting at zero.
 */
export function createIterationCounter(maxIterations: number): IterationCounter {
  let n = 0;
  return {
    start(): void {
      n += 1;
    },
    atCap(): boolean {
      return n >= maxIterations;
    },
    count(): number {
      return n;
    },
  };
}

/**
 * Test both hard limits and report the first one breached.
 *
 * @param counter - the iteration counter.
 * @param ledger - the token ledger.
 * @returns a terminal result with `reason: "iterations"` when the counter is at
 *   cap, else `reason: "tokens"` when the ledger is already at or over its cap,
 *   else non-terminal. Iterations take precedence over tokens.
 */
export function checkLimits(counter: IterationCounter, ledger: TokenLedger): BudgetCheckResult {
  if (counter.atCap()) {
    return { terminal: true, reason: "iterations" };
  }
  if (ledger.wouldExceed(0)) {
    return { terminal: true, reason: "tokens" };
  }
  return { terminal: false };
}
