import { checkLimits, type IterationCounter, type TokenLedger } from "./budget.ts";
import { evaluateSoftBudget, type SoftBudget, type SoftLimitAsk } from "./soft-budget.ts";
import type { AgentRole, TracePort } from "@clarvis/capability";

/**
 * The verdict of one per-iteration budget checkpoint: `continue` to keep
 * looping, `declined` when the user answered a soft-limit prompt by stopping (or
 * escalations are exhausted), `exhausted` when a hard limit is reached, and
 * `cancelled` when the run was aborted mid-prompt.
 */
export type CheckpointOutcome =
  { kind: "continue" } | { kind: "declined" } | { kind: "exhausted" } | { kind: "cancelled" };

/**
 * Evaluate the run's budget at one loop iteration and decide whether to proceed.
 *
 * @param args.softBudget - the soft-limit tracker; when present with
 *   `softLimitAsk`, soft evaluation runs and hard limits are not checked here.
 * @param args.softLimitAsk - the prompt that asks the user whether to continue
 *   past a crossed soft limit.
 * @param args.ledger - token ledger, read for consumed/remaining tokens.
 * @param args.counter - iteration counter, read for the iteration count.
 * @param args.agent - the role attributed on the recorded `soft_limit_check`.
 * @param args.signal - abort signal distinguishing cancellation from decline.
 * @param args.trace - handle used to record `soft_limit_check` / `budget_check`.
 * @returns a {@link CheckpointOutcome}. With a soft budget configured the result
 *   mirrors {@link evaluateSoftBudget}; otherwise it is `exhausted` when
 *   {@link checkLimits} reports a hard limit and `continue` otherwise.
 * @remarks A soft budget short-circuits the hard-limit path: only one of the two
 *   checks runs per call.
 */
export async function runBudgetCheckpoint(args: {
  softBudget?: SoftBudget;
  softLimitAsk?: SoftLimitAsk;
  ledger: TokenLedger;
  counter: IterationCounter;
  agent: AgentRole;
  signal?: AbortSignal;
  trace: TracePort;
}): Promise<CheckpointOutcome> {
  const { softBudget, softLimitAsk, ledger, counter, agent, signal, trace } = args;
  if (softBudget && softLimitAsk) {
    const ev = await evaluateSoftBudget({
      softBudget,
      softLimitAsk,
      usedTokens: ledger.consumed(),
      usedIterations: counter.count(),
      agent,
      signal,
      record: (d) => trace.record("soft_limit_check", d),
    });
    if (ev.kind === "cancelled") return { kind: "cancelled" };
    if (ev.kind === "declined") return { kind: "declined" };
    return { kind: "continue" };
  }
  const check = checkLimits(counter, ledger);
  trace.record("budget_check", {
    tokens_used: ledger.consumed(),
    tokens_remaining: Math.max(0, ledger.remaining()),
  });
  return check.terminal ? { kind: "exhausted" } : { kind: "continue" };
}
