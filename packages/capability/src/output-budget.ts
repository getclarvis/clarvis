/**
 * A concurrency-safe ceiling over model output tokens.
 *
 * The loop asks for a reservation before it starts a provider call. Holding the
 * reservation closes the otherwise unavoidable check-then-call race between
 * concurrently running agents. The provider call is capped to the granted
 * amount and settles the reservation with the usage it actually reports.
 */

/** One live claim against an {@link OutputTokenBudget}. */
export interface OutputTokenReservation {
  /** Most output tokens the guarded operation may consume. */
  readonly amount: number;
  /** Replace the provisional claim with real spend. Idempotent. */
  settle(used: number): void;
  /** Give the provisional claim back without spending it. Idempotent. */
  release(): void;
}

/**
 * A shared output-token budget.
 *
 * @remarks `reserveOutput` may grant less than requested, but never more. A
 * `null` result means there is no token of headroom left. Implementations must
 * reserve synchronously before returning so concurrent callers cannot all pass
 * a stale headroom check.
 */
export interface OutputTokenBudget {
  /** Unreserved headroom, or `Infinity` for an unbounded budget. */
  remaining(): number;
  /** Claim up to `requested` tokens for one model operation. */
  reserveOutput(requested: number): OutputTokenReservation | null;
}
