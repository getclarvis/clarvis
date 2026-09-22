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
 * Which failed completion validation an answer is being decided for.
 *
 * @returns `no_candidate` when the bound stage recorded no candidate at all and
 *   `incomplete_candidate` when one exists but does not satisfy the criteria, or
 *   `null` for a verdict that is not a deficiency of the candidate at all.
 */
function goalRecoveryCause(validation: GoalCompletionValidation): GoalRecoveryCause | null {
  if (validation.cause === "state_conflict") return null;
  return validation.cause === "no_candidate" ? "no_candidate" : "incomplete_candidate";
}

/**
 * What a finalize gate does with one deterministic completion validation.
 *
 * @remarks `valid` lets the caller continue to the Steward and the remaining
 *   gates, `recover` carries the orientation to append, and `conflict` means the
 *   attempt cannot be ruled on at all: the caller stops the stage with
 *   `goal_finalization_conflict`. The host may continue only after physical settlement
 *   under current authority, evidence and financial limits.
 */
export type GoalFinalizationRuling =
  { kind: "valid" } | { kind: "recover"; outcome: GateOutcome } | { kind: "conflict" };

/**
 * Rule on a completion validation under the one policy both Goal gates share.
 *
 * @param p.validation - the host's verdict on the attempt.
 * @param p.revalidate - re-runs that same deterministic validation.
 * @returns the ruling described by {@link GoalFinalizationRuling}.
 * @remarks A verdict that rejects the candidate on its merits recovers: the stage
 *   may simply not be finished, so the model is oriented and the run continues
 *   under the loop's own unproductive-attempt bound.
 *
 *   `state_conflict` is neither. It reports that the goal or its observation
 *   generation moved while the check ran, so the verdict says nothing about the
 *   candidate, and answering it with a candidate-deficiency orientation would
 *   consume the run's allowance for a condition the model cannot act on — and
 *   would report stagnation for a stage that never stagnated. It is re-read once
 *   instead: accepting a human criterion is exactly what makes such a candidate
 *   completable, so a non-revoking human acceptance landing inside the window
 *   must still be able to settle the attempt, and the host revalidates before the
 *   durable commit for the same reason. Only a conflict that survives the re-read
 *   ends the stage with a distinct recoverable cause, never an approval. The existing
 *   host continuation path re-evaluates proof in a fresh stage; no model or tool call
 *   is retried here, and obsolete authority still refuses continuation.
 */
export async function ruleGoalFinalization(p: {
  validation: GoalCompletionValidation;
  revalidate: () => Promise<GoalCompletionValidation>;
  trace: TracePort;
  execution_id: string;
  agent: AgentRole;
  mode: FinalizeAttempt["mode"];
}): Promise<GoalFinalizationRuling> {
  const recoverable = (validation: GoalCompletionValidation): GoalFinalizationRuling => {
    const cause = goalRecoveryCause(validation);
    if (cause === null) return { kind: "conflict" };
    return {
      kind: "recover",
      outcome: recoverGoalFinalization({
        trace: p.trace,
        execution_id: p.execution_id,
        agent: p.agent,
        mode: p.mode,
        cause,
        reasons: validation.reasons,
      }),
    };
  };
  if (p.validation.valid) return { kind: "valid" };
  if (p.validation.cause !== "state_conflict") return recoverable(p.validation);
  const refreshed = await p.revalidate();
  if (refreshed.valid) return { kind: "valid" };
  return recoverable(refreshed);
}
