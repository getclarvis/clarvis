/**
 * The convergence-guard vocabulary. Types only: the doom-loop and stagnation
 * guards themselves stay in `@clarvis/loop`, and a capability only ever holds
 * the combined handle to feed tool results into it.
 */

/**
 * A tripped convergence guard: the `code` naming which guard fired
 * (`tool_failure_loop` for the doom-loop guard, `stagnation_detected` for the
 * stagnation guard) and a human-readable `message`.
 */
export interface GuardTrip {
  code: "tool_failure_loop" | "stagnation_detected";
  message: string;
}

/**
 * A soft-tier convergence warning: the `code` naming which guard is close to
 * firing, and a `message` written for the model to act on.
 */
export interface GuardWarning {
  code: GuardTrip["code"];
  message: string;
}

/**
 * The combined convergence guard: fold each tool result in, then ask whether any
 * guard wants to warn the model or has decided the loop is unproductive.
 */
export interface ConvergenceGuards {
  /** Feed one tool result: its call `signature`, the `resultText`, and whether
   * it was an error. */
  record(signature: string, resultText: string, isError: boolean): void;
  /**
   * Pending soft-tier warnings from either guard, each yielded once.
   *
   * @remarks Consumed by reading, so the caller needs no memory of what it has
   *   already shown.
   */
  takeSoft(): GuardWarning[];
  /** The first tripped guard, or `null` while the loop is still productive. */
  tripped(): GuardTrip | null;
  /**
   * Clear both guards' trips and counters.
   *
   * @remarks Used when a human answers a guard escalation with "continue". The
   *   counters go with the latch, or the next single failure re-trips and the
   *   escalation was theatre.
   */
  reset(): void;
}
