import { createDoomLoopGuard } from "./doom-loop-guard.ts";
import { createStagnationGuard, hashResult } from "./stagnation-guard.ts";

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

/**
 * Create the combined {@link ConvergenceGuards} that fans each recorded result
 * out to both the doom-loop and stagnation guards.
 *
 * @param opts.stagnationThreshold - repeat count that trips the stagnation guard
 *   (see {@link createStagnationGuard}); the doom-loop guard uses its own fixed
 *   thresholds.
 * @returns the combined guard.
 * @remarks {@link ConvergenceGuards.tripped} reports the doom-loop guard first
 *   (repeated or consecutive failures), then stagnation (identical results).
 */
export function createConvergenceGuards(
  opts: { stagnationThreshold?: number; stagnationSoftThreshold?: number } = {},
): ConvergenceGuards {
  const doom = createDoomLoopGuard();
  const stag = createStagnationGuard({
    threshold: opts.stagnationThreshold,
    ...(opts.stagnationSoftThreshold !== undefined ? { soft: opts.stagnationSoftThreshold } : {}),
  });
  return {
    record(signature: string, resultText: string, isError: boolean): void {
      doom.record(signature, isError);
      stag.record(signature, hashResult(resultText), isError);
    },
    takeSoft(): GuardWarning[] {
      const out: GuardWarning[] = [];
      const doomSoft = doom.takeSoft();
      if (doomSoft !== null) out.push({ code: "tool_failure_loop", message: doomSoft });
      const stagSoft = stag.takeSoft();
      if (stagSoft !== null) out.push({ code: "stagnation_detected", message: stagSoft });
      return out;
    },
    tripped(): GuardTrip | null {
      if (doom.tripped()) return { code: "tool_failure_loop", message: doom.reason() };
      if (stag.tripped()) return { code: "stagnation_detected", message: stag.reason() };
      return null;
    },
    reset(): void {
      doom.reset();
      stag.reset();
    },
  };
}
