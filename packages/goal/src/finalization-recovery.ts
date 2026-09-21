import type { AgentRole, FinalizeAttempt, GateOutcome, TracePort } from "@clarvis/capability";
import type { GoalCompletionValidation } from "./criteria.ts";

/**
 * Why a guided Goal stage tried to end without a completable Goal.
 *
 * @remarks A closed vocabulary rather than free text. The operator-facing
 *   orientation and the durable evidence carry this cause, so neither has to copy
 *   model prose, the objective or reasoning — and no gate has to classify the
 *   model's intention by matching words such as "vou" or "sigo". `no_goal` covers
 *   the guided creation turn, which has not created the Goal yet;
 *   `no_candidate` and `incomplete_candidate` split the two recoverable shapes of
 *   a bound stage's failed completion validation.
 */
export type GoalRecoveryCause = "no_goal" | "no_candidate" | "incomplete_candidate";

/**
 * The trace kind one answered premature finalization is recorded under.
 *
 * @remarks Deliberately absent from the engine's `BUILTIN_TRACE_KINDS`: this is a
 *   Goal-owned observation, and the loop neither names Goal behavior nor needs a
 *   branch for it. The entry is a contributed one, so it rides the generic bounded
 *   capability projection and adds no protocol vocabulary.
 */
export const GOAL_RECOVERY_TRACE_KIND = "goal_finalization_recovery";

/**
 * Bounded durable evidence for one answered premature finalization.
 *
 * @remarks `reasons` are the host's own criterion/evidence verdicts, not the
 *   model's text: they name which criterion or evidence reference failed, which is
 *   what makes the recovery diagnosable after the fact. The run identity is
 *   carried explicitly because the gate answers before any loop-level accounting
 *   exists for that attempt.
 */
export interface GoalRecoveryDetail {
  execution_id: string;
  agent: AgentRole;
  mode: FinalizeAttempt["mode"];
  cause: GoalRecoveryCause;
  reasons: string[];
}

/**
 * Longest set of host reasons copied into one recovery record.
 *
 * @remarks The completion validator emits one reason per unmet criterion or
 *   evidence reference, so the list is bounded by the definition's own bounds.
 *   Capping it here keeps one refused finalization from writing an unbounded entry
 *   into the trace while still naming everything a normal definition can fail.
 */
const MAX_RECOVERED_REASONS = 8;

/**
 * The single orientation every Goal finalize gate gives a premature final.
 *
 * @param cause - the typed reason the stage cannot conclude.
 * @param reasons - the host's own verdicts, appended verbatim.
 * @returns one paragraph telling the model the Goal cannot conclude yet and what
 *   it may do next.
 * @remarks Two properties matter. It never asks the model to fabricate a
 *   candidate before continuing: continuing the work, reading the criteria and
 *   checkpointing remain equally valid answers, because the stage may simply not
 *   be finished. And it never attributes a decision to the Goal Steward, which
 *   this recovery can be reached without ever having called.
 */
export function goalRecoveryNote(cause: GoalRecoveryCause, reasons: readonly string[]): string {
  const missing =
    cause === "no_goal"
      ? "the Goal has not been created yet"
      : cause === "no_candidate"
        ? "no completion candidate has been recorded for this stage"
        : "the recorded completion candidate does not satisfy every current criterion";
  const direction =
    cause === "no_goal"
      ? "Define the objective and criteria with create_goal first"
      : "Continue the work, read get_goal for the exact criteria, record a candidate with update_goal, or request a checkpoint for the remaining work";
  const detail = reasons.length === 0 ? "" : ` ${reasons.join("; ")}.`;
  return `The Goal cannot conclude yet: ${missing}. ${direction}, then finish.${detail}`;
}

/**
 * Answer a premature finalization with the shared recovery orientation.
 *
 * @param p.trace - the run trace the bounded evidence is recorded on.
 * @param p.execution_id - the bound execution the gate answers for.
 * @param p.agent - the agent whose finalize attempt was refused.
 * @param p.mode - the attempt mode the gate ruled on.
 * @param p.cause - the typed reason the stage cannot conclude.
 * @param p.reasons - the host's own completion verdicts, if any.
 * @returns an `unbounded` nudge. The flag is what makes the recovery fair and
 *   finite at once: the gate itself keeps no counter, and the loop counts the
 *   refused finalize as one unproductive iteration, clears the sequence on any
 *   productive iteration and ends the run with `no_progress` only when the
 *   unproductive streak reaches the persona's existing limit. A capability
 *   therefore cannot buy itself unbounded iterations with it — exemption from its
 *   own nudge budget is not permission to run forever.
 */
export function recoverGoalFinalization(p: {
  trace: TracePort;
  execution_id: string;
  agent: AgentRole;
  mode: FinalizeAttempt["mode"];
  cause: GoalRecoveryCause;
  reasons?: readonly string[];
}): GateOutcome {
  const reasons = [...(p.reasons ?? [])].slice(0, MAX_RECOVERED_REASONS);
  p.trace.record(GOAL_RECOVERY_TRACE_KIND, {
    execution_id: p.execution_id,
    agent: p.agent,
    mode: p.mode,
    cause: p.cause,
    reasons,
  } satisfies GoalRecoveryDetail);
  return { kind: "nudge", note: goalRecoveryNote(p.cause, reasons), unbounded: true };
}

/**
 * Classify a failed completion validation that is already known to be recoverable.
 *
 * @param validation - the host's deterministic completion verdict.
 * @returns `no_candidate` when the bound stage recorded no candidate at all, or
 *   `incomplete_candidate` when one exists but does not satisfy the criteria.
 * @remarks The host sets `cause: "no_candidate"` only on the early return that
 *   finds nothing to validate. Reading it here — rather than matching the
 *   verdict's prose — is what keeps the two recoverable shapes distinguishable
 *   without the gate guessing at human-readable text.
 */
export function goalRecoveryCause(validation: GoalCompletionValidation): GoalRecoveryCause {
  return validation.cause === "no_candidate" ? "no_candidate" : "incomplete_candidate";
}
