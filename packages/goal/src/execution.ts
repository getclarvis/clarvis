import { GoalError } from "./errors.ts";
import { boundedGoalState, emptyGoalState } from "./control.ts";
import {
  describeExecutions,
  goalAdmission,
  goalDeadlineLimit,
  goalHasPhysicalRun,
  goalNetTokens,
  unacceptedUsageRuns,
} from "./policy.ts";
import {
  goalCandidateSchema,
  goalCheckpointSchema,
  goalProgressSchema,
  goalUsageSchema,
  GOAL_STAGE_ACTIVITY_MAX,
  type GoalCandidate,
  type GoalCheckpoint,
  type GoalProgress,
  type GoalRecord,
  type GoalRun,
  type GoalRunCause,
  type GoalUsageGapCause,
  type GoalStageDecision,
  type GoalState,
  type GoalUsage,
} from "./schemas.ts";

function currentGoal(state: GoalState, goalId: string): GoalRecord {
  const goal = state.current;
  if (goal === undefined || goal.goal_id !== goalId)
    throw new GoalError("conflict", "Goal execution belongs to another objective");
  return goal;
}

function boundRun(goal: GoalRecord, executionId: string): GoalRun {
  const run = goal.runs.find((value) => value.execution_id === executionId);
  if (run === undefined) throw new GoalError("conflict", "Execution is not bound to this goal");
  return run;
}

function changed(state: GoalState, goal: GoalRecord, now: number): GoalState {
  state.revision += 1;
  goal.revision = state.revision;
  goal.updated_at = now;
  return boundedGoalState(state, true);
}

/**
 * Persist a guided creation intent in the existing session document. A pending
 * intent is not a Goal and does not authorize implementation.
 */
export function admitGoalCreationIntent(
  previous: GoalState | undefined,
  input: {
    session_id: string;
    execution_id: string;
    operation_id: string;
    seed: string;
    expected_revision: number;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous ?? emptyGoalState(), true);
  if (state.current !== undefined && state.current.session_id !== input.session_id)
    throw new GoalError("conflict", "Goal belongs to another conversation");
  if (
    state.current !== undefined &&
    state.current.status !== "complete" &&
    state.current.status !== "cancelled"
  )
    throw new GoalError("conflict", "A Goal already exists for this conversation");
  const known = state.creation_intent;
  if (
    known !== undefined &&
    known.execution_id === input.execution_id &&
    known.operation_id === input.operation_id &&
    known.seed === input.seed
  )
    return state;
  if (state.revision !== input.expected_revision)
    throw new GoalError("conflict", "Goal revision changed; reload before applying control");
  if (known !== undefined && known.execution_id === input.execution_id && known.seed !== input.seed)
    throw new GoalError("conflict", "Creation intent already admitted for a different request");
  state.revision += 1;
  state.creation_intent = {
    seed: input.seed,
    execution_id: input.execution_id,
    operation_id: input.operation_id,
    phase: "formulating",
    admitted_at: input.now,
  };
  return boundedGoalState(state, true);
}

/** Persist the unique run intent under the host's conversation exclusion before inference. */
export function admitGoalRun(
  previous: GoalState,
  input: {
    goal_id: string;
    expected_revision: number;
    control_revision: number;
    execution_id: string;
    admission_id: string;
    automatic: boolean;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const existing = goal.runs.find(
    (run) => run.execution_id === input.execution_id || run.admission_id === input.admission_id,
  );
  if (existing !== undefined) {
    if (
      existing.execution_id !== input.execution_id ||
      existing.admission_id !== input.admission_id ||
      existing.control_revision !== input.control_revision
    )
      throw new GoalError("conflict", "Goal admission identity was already used");
    return state;
  }
  if (
    state.revision !== input.expected_revision ||
    goal.control_revision !== input.control_revision
  )
    throw new GoalError("conflict", "Goal changed before admission");
  const decision = goalAdmission(goal, input.now, input.automatic);
  if (!decision.allowed)
    throw new GoalError(
      decision.status === "paused" ? "blocked" : decision.status,
      decision.reason,
    );
  goal.runs.push({
    execution_id: input.execution_id,
    admission_id: input.admission_id,
    control_revision: input.control_revision,
    objective_revision: goal.objective_revision,
    automatic: input.automatic,
    admitted_at: input.now,
    phase: "preparing",
    steward_reviews: [],
    steward_review_count: 0,
  });
  if (input.automatic) goal.auto_continuations += 1;
  return changed(state, goal, input.now);
}

/** A repeated observation cannot move a closed run back into physical execution. */
export function advanceGoalRun(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    phase: "running" | "settling" | "unknown";
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (run.phase === "closed" || run.phase === input.phase) return state;
  if (
    input.phase === "running" &&
    (run.phase !== "preparing" ||
      goal.status !== "active" ||
      run.control_revision !== goal.control_revision)
  )
    throw new GoalError("conflict", "Goal run admission was revoked before start");
  if (run.phase === "unknown" && input.phase !== "unknown")
    throw new GoalError("blocked", "An unknown execution requires host recovery");
  run.phase = input.phase;
  if (input.phase === "unknown" && goal.status === "active") {
    goal.status = "blocked";
    goal.reason = PHYSICAL_UNKNOWN_REASON;
  }
  return changed(state, goal, input.now);
}

/**
 * The reason a Goal is blocked on an execution whose physical ending was never observed.
 *
 * @remarks Named so {@link closeGoalRunByRecovery} can recognize exactly the block it resolves and
 *   leave every other one alone: a Goal blocked for any other reason must not be reopened by a
 *   recovery that had nothing to do with it.
 */
const PHYSICAL_UNKNOWN_REASON = "Physical execution outcome is unknown; host recovery is required";

/**
 * Release the conversation from a stage whose physical ending the host could not observe.
 *
 * @param previous - the Goal state to transition.
 * @param input - the Goal, the execution the host resolved, and the attestation instant.
 * @returns the state with that run closed, its occupancy released and its audit intact.
 * @remarks The operator has established that no process of that execution is still running; nobody
 *   has established what it produced, and this transition does not pretend otherwise. The run
 *   therefore closes with `recovered_at` recorded and **no** outcome, disposition, decision or
 *   terminal cause, so nothing downstream can read a result that was never observed, and the stage
 *   is not counted as an unproductive one because it is uncountable rather than unproductive.
 *   Releasing the physical block re-runs the Goal's consumption reconciliation: a recovered stage
 *   whose consumption was never measured leaves a gap, which asks for an explicit acceptance
 *   instead of silently letting the next attempt start against an unknown baseline. A second
 *   resolution for the same execution is a no-op.
 */
export function closeGoalRunByRecovery(
  previous: GoalState,
  input: { goal_id: string; execution_id: string; recovered_at: number },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (run.phase === "closed") return state;
  run.phase = "closed";
  run.recovered_at = input.recovered_at;
  reconcileUsage(goal);
  if (goal.status === "blocked" && goal.reason === PHYSICAL_UNKNOWN_REASON) {
    const unaccepted = unacceptedUsageRuns(goal);
    goal.status = unaccepted.length === 0 ? "active" : "blocked";
    if (unaccepted.length === 0) delete goal.reason;
    else
      goal.reason = `Consumption is unknown for ${String(unaccepted.length)} recovered stage(s) (${describeExecutions(unaccepted)}); resume the goal to accept the gap`;
  }
  return changed(state, goal, input.recovered_at);
}

/** Accept bounded host-evaluated checkpoint data; repeated activity cannot reset stagnation. */
export function recordGoalCheckpoint(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    objective_revision: number;
    checkpoint: GoalCheckpoint;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (
    run.phase !== "running" ||
    (goal.status !== "active" && goal.status !== "paused") ||
    goal.objective_revision !== input.objective_revision
  )
    throw new GoalError("conflict", "Checkpoint does not belong to the active goal run");
  const checkpoint = goalCheckpointSchema.parse(input.checkpoint);
  checkpoint.progress_accepted =
    checkpoint.progress_accepted &&
    checkpoint.activity_fingerprint !== undefined &&
    !goal.runs.some(
      (other) =>
        other.execution_id !== run.execution_id &&
        other.checkpoint?.activity_fingerprint === checkpoint.activity_fingerprint,
    );
  run.checkpoint = checkpoint;
  return changed(state, goal, input.now);
}

/** A completion candidate is inspectable data until the kernel commits physical/durable settlement. */
export function recordGoalCandidate(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    candidate: GoalCandidate;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  const candidate = goalCandidateSchema.parse(input.candidate);
  if (
    run.phase !== "running" ||
    (goal.status !== "active" && goal.status !== "paused") ||
    candidate.execution_id !== run.execution_id ||
    candidate.objective_revision !== goal.objective_revision
  )
    throw new GoalError("conflict", "Candidate does not belong to the active objective revision");
  run.candidate = candidate;
  goal.candidate = candidate;
  return changed(state, goal, input.now);
}

/** Record entry-agent progress without changing completion, physical phase or stagnation counters. */
export function recordGoalProgress(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    objective_revision: number;
    progress: GoalProgress;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (
    run.phase !== "running" ||
    (goal.status !== "active" && goal.status !== "paused") ||
    goal.objective_revision !== input.objective_revision
  )
    throw new GoalError("conflict", "Progress does not belong to the bound goal run");
  run.progress = goalProgressSchema.parse(input.progress);
  return changed(state, goal, input.now);
}

/**
 * Record a bound stage's declared impediment without revoking the Goal's own authority.
 *
 * @param previous - the durable goal state.
 * @param input - the bound goal/stage, objective revision, the model's reason and the clock.
 * @returns the state with the declaration recorded on the stage, or the unchanged state.
 * @remarks `update_goal blocked` is a report, not an operator control. It used to set
 *   `status: blocked` and advance the control fence, so one declared blocker spent the
 *   Goal's whole automatic path and made a human intervention mandatory even when the
 *   model could still make progress under the same objective and authorization. The
 *   declaration is now durable evidence on the closing stage: the stage still ends, the
 *   settlement decides under the remaining limits whether a successor may re-evaluate
 *   down a different approach, and a persistent impediment still blocks the Goal with its
 *   bounded reason once that allowance is spent. No human authority is invented, and a
 *   genuine operator pause, cancel or replacement keeps immediate precedence because
 *   the current control revision and objective revision are what the settlement fences
 *   against. A repeated declaration is idempotent and does not move the revision: one
 *   stage reports at most one blocker, and the first one is what the operator sees.
 */
export function declareGoalImpediment(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    objective_revision: number;
    reason: string;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (
    run.objective_revision !== input.objective_revision ||
    goal.objective_revision !== input.objective_revision
  )
    throw new GoalError("conflict", "Impediment belongs to an obsolete goal revision");
  if (goal.status !== "active") return state;
  if (run.phase !== "running")
    throw new GoalError("conflict", "Impediment requires the bound running stage");
  const reason = goalProgressSchema.shape.summary.parse(input.reason);
  if (run.impediment !== undefined) return state;
  run.impediment = { reason, declared_at: input.now };
  return changed(state, goal, input.now);
}

/**
 * The operator-facing sentence for one unsuccessful stage, chosen from the closed cause.
 *
 * @param outcome - the physical outcome the host reported.
 * @param cause - the host's typed reason for this stage.
 * @returns a fixed sentence. Stagnation and a control failure are named as
 *   themselves rather than folded into the generic failed-stage wording, because a
 *   blocked goal is what the operator must act on: a stalled stage needs an
 *   explicit resume or edit, and an unreadable control needs host attention.
 *   Cancellation keeps its own wording, and a cause the host cannot name keeps the
 *   generic one. The cause map is data rather than a branch per cause so that every
 *   member of the closed vocabulary owns exactly one sentence.
 */
const FAILURE_REASONS: Record<GoalRunCause, string> = {
  checkpoint: "Run ended without an accepted checkpoint and no successor could be admitted",
  local_limit: "The stage reached its own limit and no successor could be admitted",
  declined: "The limit extension was declined; the goal requires an explicit operator decision",
  cancelled: "Goal run was cancelled",
  stagnation:
    "The stage stopped after repeated attempts without progress; the goal requires an explicit resume or edit",
  empty_response: "The stage ended without producing an answer and no successor could be admitted",
  impediment: "The stage declared an impediment; the goal requires operator action",
  transient: "The provider failed transiently and no successor could be admitted",
  steward_interrupted: "The completion review was interrupted and no successor could be admitted",
  usage_unknown:
    "The completion review's consumption could not be determined; reconcile it before continuing",
  context_overflow: "The stage could not fit its context",
  provider_refused: "The provider refused the request; the goal requires operator action",
  tools_unavailable: "Every configured tool became unavailable",
  control_failure: "Goal control was unavailable; the goal requires host attention",
  unclassified: "Goal run failed",
};

/**
 * The sentence a Goal carries while it stays active and another stage continues it.
 *
 * @remarks The reason names the ending, never a prompt, an objective or a model's
 *   prose: the operator has to be able to tell why a stage stopped and that the Goal
 *   did not become their responsibility because of it.
 */
const CONTINUATION_REASONS: Record<GoalRunCause, string> = {
  checkpoint: "The stage handed off with an accepted checkpoint; another stage continues the goal",
  local_limit: "The stage reached its own limit; another stage continues the goal",
  declined: "The limit extension was declined; the goal requires an explicit operator decision",
  cancelled: "The stage was cancelled; the goal requires an explicit resume",
  stagnation: "The stage stopped without progress; the next stage must change its approach",
  empty_response: "The stage produced no answer; another stage continues the goal",
  impediment: "The stage declared an impediment; another stage re-evaluates it",
  transient: "The provider failed transiently; another stage resumes the goal",
  steward_interrupted: "The completion review was interrupted; another stage continues the goal",
  usage_unknown: "The completion review's consumption could not be determined and the goal stopped",
  context_overflow: "The stage could not fit its context; another stage continues the goal",
  provider_refused: "The provider refused the request; the goal requires operator action",
  tools_unavailable: "Every configured tool became unavailable",
  control_failure: "Goal control was unavailable; the goal requires host attention",
  unclassified: "Goal run failed",
};

/**
 * The causes a successor stage may re-evaluate under the Goal's remaining limits.
 *
 * @remarks Membership is what makes an ending recoverable, and every member still
 *   spends one stage of the Goal's progress allowance when the stage did not advance
 *   the work — so repetition of the same failure cannot restart indefinitely and no
 *   recovery invents authorization, budget or evidence. `context_overflow` is not a
 *   member: continuing it is only safe when the stage also observed progress, because
 *   otherwise the successor would replay the payload that did not fit. Everything
 *   absent — a credential or quota refusal, unavailable tools, an unreadable control,
 *   an unclassified fault and a model-declared impediment — is never presumed
 *   recoverable.
 *
 *   A declared impediment is deliberately outside this set. The host cannot separate a
 *   model reporting its own dead end from a model reporting a refusal the operator just
 *   made — a refused plan review reaches settlement through the model's own blocker — so
 *   admitting a successor for it would let the recovery path retry work an authenticated
 *   decision had just refused. The declaration still costs the Goal nothing: it is
 *   recorded on the stage, the control revision does not move, and resume continues with
 *   the same budget, limits and approvals.
 */
const RECOVERABLE_CAUSES: ReadonlySet<GoalRunCause> = new Set<GoalRunCause>([
  "checkpoint",
  "local_limit",
  "stagnation",
  "empty_response",
  "transient",
  "steward_interrupted",
]);

/** Whether the closed stage may be continued automatically by one successor stage. */
function stageContinuationAllowed(cause: GoalRunCause, progressObserved: boolean): boolean {
  if (cause === "context_overflow") return progressObserved;
  return RECOVERABLE_CAUSES.has(cause);
}

function failureReason(outcome: "failed" | "cancelled", cause: GoalRunCause): string {
  return outcome === "cancelled" ? "Goal run was cancelled" : FAILURE_REASONS[cause];
}

/**
 * A stage's activity as the Goal recorded it so far, so a successor can be compared with the
 * whole history rather than with its predecessor alone.
 */
function recordedActivity(goal: GoalRecord): Set<string> {
  return new Set(goal.runs.flatMap((item) => item.activity ?? []));
}

/**
 * Whether a late measurement of an already-settled stage only adds information.
 *
 * @param previous - the measurement already recorded and charged for that execution.
 * @param next - the measurement a later reconciliation produced.
 * @returns true when `next` resolves a scope that had no subtotal, or is at least as large in
 *   every charged dimension; false when it would take measured consumption back.
 * @remarks Late telemetry arrives as a correction that *adds*: a provider that finally reports
 *   cache reuse raises `cached` — which lowers the net charge without lowering the gross figures
 *   it is computed from — and input and output can only stay or grow. A revision that would lower
 *   a charged dimension is a conflict rather than an update, and refusing it is what keeps a
 *   measurement from being overwritten by a smaller one that would silently return budget the
 *   Goal already spent. An identical revision never reaches this test: it is a no-op by identity.
 */
function isInformationGaining(previous: GoalUsage | undefined, next: GoalUsage): boolean {
  if (previous === undefined || previous.kind === "unknown") return next.kind !== "unknown";
  if (next.kind === "unknown") return false;
  return (
    next.input >= previous.input &&
    next.output >= previous.output &&
    (next.cached ?? 0) >= (previous.cached ?? 0)
  );
}

function reconcileUsage(goal: GoalRecord): void {
  const accepted = new Set(goal.consumption.usage_accepted_runs);
  const gapCalls = new Map<GoalUsageGapCause, number>();
  const stillIncomplete: string[] = [];
  const totals: GoalRecord["consumption"] = {
    input: 0,
    output: 0,
    cached: 0,
    net_tokens: 0,
    usage_unknown: false,
    cache_estimated: false,
    overrun_tokens: 0,
    gaps: [],
    usage_accepted_runs: [],
  };
  for (const run of goal.runs) {
    if (run.phase !== "closed") continue;
    if (run.usage === undefined || run.usage.kind === "unknown") {
      totals.usage_unknown = true;
      if (accepted.has(run.execution_id)) stillIncomplete.push(run.execution_id);
      continue;
    }
    totals.input += run.usage.input;
    totals.output += run.usage.output;
    totals.net_tokens += goalNetTokens(run.usage)!;
    if (run.usage.cached === undefined && run.usage.input > 0) {
      delete totals.cached;
      totals.cache_estimated = true;
    } else if (totals.cached !== undefined) totals.cached += run.usage.cached ?? 0;
    if (run.usage.kind === "partial") {
      for (const gap of run.usage.gaps)
        gapCalls.set(gap.cause, (gapCalls.get(gap.cause) ?? 0) + gap.calls);
      if (accepted.has(run.execution_id)) stillIncomplete.push(run.execution_id);
    }
  }
  totals.overrun_tokens = Math.max(0, totals.net_tokens - goal.limits.max_net_tokens);
  totals.gaps = [...gapCalls.entries()]
    .map(([cause, calls]) => ({ cause, calls }))
    .sort((left, right) => left.cause.localeCompare(right.cause));
  /**
   * Acceptance survives re-reconciliation, because charging is not a decision.
   *
   * @remarks An acceptance is per execution and is carried forward only while that execution is
   *   *still* not fully measured: a late measurement that completes it drops the acceptance with
   *   the gap it belonged to, and an execution absent from the audit cannot keep one.
   */
  totals.usage_accepted_runs = [...new Set(stillIncomplete)];
  goal.consumption = totals;
}

/** Run-scoped live snapshots are estimates; only durable settlement charges confirmed totals. */
export function recordGoalUsageEstimate(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    sequence: number;
    usage: GoalUsage;
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = currentGoal(state, input.goal_id);
  const run = boundRun(goal, input.execution_id);
  if (run.phase === "closed" || (run.usage_estimate?.sequence ?? -1) >= input.sequence)
    return state;
  run.usage_estimate = { sequence: input.sequence, usage: goalUsageSchema.parse(input.usage) };
  return changed(state, goal, input.now);
}

/**
 * Reconcile only after physical closure, and decide what the closed stage leaves behind.
 *
 * @param previous - the durable goal state.
 * @param input - the physical facts, the host's classification of the ending and the clock.
 * @returns the state with the stage closed and its durable decision recorded.
 * @remarks Late usage always belongs to the original binding, even after pause or archive;
 *   status changes require the still-current control/objective revision; missing telemetry
 *   blocks continuation, and a checkpoint never turns a failed run into success.
 *
 *   The host supplies the physical facts and one classified `cause`; the decision is the
 *   domain's. A recoverable ending keeps the Goal `active` and records `decision: "continue"`,
 *   which is what lets the Kernel keep responsibility for a pending Goal without a
 *   model-generated checkpoint: the host admits the successor from this durable record rather
 *   than from the run's physical shape. A stage that advanced the work clears the no-progress
 *   sequence, one that did not spends a stage of it, and an exhausted allowance blocks the
 *   Goal through the ordinary admission path instead of looping. Everything the host could not
 *   classify is `attention`, and a successor is never automatic for it.
 *   `progress_observed` is the host's own observation of the stage's activity — an accepted
 *   checkpoint is one way to have it, not the only one.
 */
export function settleGoalRun(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    physical_closed: true;
    outcome: "completed" | "failed" | "cancelled";
    disposition: "final" | "checkpoint";
    usage: GoalUsage;
    completion_validated: boolean;
    cause?: GoalRunCause;
    /**
     * The stage's own observed activity receipts, as the host collected them.
     *
     * @remarks Receipts, not a verdict: the domain compares each one with the Goal's whole
     *   recorded history and decides both what this stage contributed and whether it advanced
     *   the work. A stage that observed nothing, or only receipts an earlier stage already
     *   presented, contributes nothing — recombining old receipts is not new progress.
     */
    activity?: readonly string[];
    not_before?: number;
    now: number;
  },
): GoalState {
  if (input.physical_closed !== true)
    throw new GoalError("blocked", "Goal settlement requires physical closure");
  const state = boundedGoalState(previous, true);
  const goal =
    state.current?.goal_id === input.goal_id
      ? state.current
      : state.archive.find((value) => value.goal_id === input.goal_id);
  if (goal === undefined)
    throw new GoalError("conflict", "Goal settlement belongs to another objective");
  const run = boundRun(goal, input.execution_id);
  const usage = goalUsageSchema.parse(input.usage);
  if (run.phase === "closed") {
    if (JSON.stringify(run.usage) === JSON.stringify(usage)) return state;
    const beforeRevision = run.usage?.kind === "unknown" ? undefined : run.usage?.revision;
    const nextRevision = usage.kind === "unknown" ? undefined : usage.revision;
    if (beforeRevision !== undefined && nextRevision !== undefined && nextRevision < beforeRevision)
      return state;
    if (beforeRevision !== undefined && nextRevision === beforeRevision)
      throw new GoalError("conflict", "Conflicting measurements at the same revision");
    if (
      !(nextRevision !== undefined && nextRevision > (beforeRevision ?? -1)) &&
      !isInformationGaining(run.usage, usage)
    )
      throw new GoalError("conflict", "Settled goal usage cannot be rewritten");
    run.usage = usage;
    reconcileUsage(goal);
    return changed(state, goal, input.now);
  }
  run.phase = "closed";
  run.ended_at = input.now;
  run.outcome = input.outcome;
  run.disposition = input.disposition;
  run.usage = usage;
  /**
   * The run's own durable record outranks the host's classification in two cases, because
   * the host only ever sees the code the loop reported.
   *
   * A declared impediment is what the model reported. A completion review whose consumption
   * could not be determined is a technical interruption the code does not carry: the
   * evaluation answered — possibly with a valid `achieved` — but the host cannot charge it,
   * so the Goal is never continued on it automatically, while a review that merely timed
   * out, failed in transit or returned unusable output may be re-evaluated by one bounded
   * successor stage under the ordinary stage allowance. A stage that produced a validated
   * completion has no failure cause to record.
   */
  const concluded = input.outcome === "completed" && input.disposition === "final";
  /**
   * What this stage contributes is decided per receipt against the Goal's whole history, not
   * by digesting the stage's activity set: a stage that only recombines receipts an earlier
   * stage already presented advanced nothing, however different the combined set looks.
   */
  const seen = recordedActivity(goal);
  const contributed = [...new Set(input.activity ?? [])].filter((item) => !seen.has(item)).sort();
  run.activity = contributed.slice(0, GOAL_STAGE_ACTIVITY_MAX);
  const unaccountable =
    run.steward_reviews.at(-1)?.interruption_cause === "usage_unknown" && !concluded;
  const cause: GoalRunCause =
    run.impediment !== undefined && input.outcome !== "completed"
      ? "impediment"
      : unaccountable
        ? "usage_unknown"
        : (input.cause ?? "unclassified");
  if (concluded) delete run.cause;
  else run.cause = cause;
  /**
   * The classified instant is a durable fact about the stage, recorded whether or not this
   * settlement ends up admitting a successor: a Goal that blocks on unknown consumption must
   * still honour the provider's own backoff when the operator resolves it and work resumes.
   */
  if (concluded || input.not_before === undefined) delete run.not_before;
  else run.not_before = input.not_before;
  const progressObserved = contributed.length > 0 || run.checkpoint?.progress_accepted === true;
  run.progress_observed = progressObserved;
  reconcileUsage(goal);
  const closed = (decision: GoalStageDecision): GoalState => {
    run.decision = decision;
    return changed(state, goal, input.now);
  };
  /** Spend one stage of the progress allowance; true when admission refused a successor. */
  const spendStage = (): boolean => {
    goal.no_progress_stages = progressObserved ? 0 : goal.no_progress_stages + 1;
    const admission = goalAdmission(goal, input.now, true);
    if (admission.allowed) return false;
    goal.status = admission.status;
    goal.reason = admission.reason;
    return true;
  };
  const deadline = goalDeadlineLimit(goal, input.now);
  if (
    goal.status !== "active" ||
    run.control_revision !== goal.control_revision ||
    run.objective_revision !== goal.objective_revision
  )
    return closed("closed");
  const unacceptedUsage = unacceptedUsageRuns(goal);
  if (unacceptedUsage.length > 0) {
    goal.status = "blocked";
    goal.reason = goal.consumption.usage_unknown
      ? `Consumption is unknown for ${String(unacceptedUsage.length)} closed stage(s) (${describeExecutions(unacceptedUsage)}); resume the goal to accept the gap`
      : `Consumption is partially unmeasured for ${String(unacceptedUsage.length)} closed stage(s) (${describeExecutions(unacceptedUsage)}); resume the goal to accept the gap`;
    return closed("attention");
  }
  if (deadline !== undefined) {
    goal.status = deadline.status;
    goal.reason = deadline.reason;
    return closed("closed");
  }
  if (input.outcome !== "completed") {
    if (!stageContinuationAllowed(cause, progressObserved)) {
      const budget = goalAdmission(goal, input.now, false);
      if (!budget.allowed && budget.status === "budget_limited") {
        goal.status = budget.status;
        goal.reason = budget.reason;
        return closed("closed");
      }
      goal.status = "blocked";
      goal.reason =
        run.impediment !== undefined ? run.impediment.reason : failureReason(input.outcome, cause);
      return closed(input.outcome === "cancelled" || cause === "declined" ? "closed" : "attention");
    }
    if (spendStage()) return closed("closed");
    goal.reason = CONTINUATION_REASONS[cause];
    return closed("continue");
  }
  if (input.disposition === "final") {
    if (
      input.completion_validated &&
      run.candidate !== undefined &&
      run.candidate.objective_revision === goal.objective_revision
    ) {
      goal.status = "complete";
      delete goal.steward.last_steward_execution_id;
      goal.reason = "Completion committed after criteria, gates and durable reconciliation";
      return closed("complete");
    }
    goal.status = "blocked";
    goal.reason = "Run ended without a validated completion candidate or checkpoint";
    return closed("attention");
  }
  if (run.checkpoint === undefined) {
    goal.status = "blocked";
    goal.reason = "Run ended without an accepted checkpoint";
    return closed("attention");
  }
  if (spendStage()) return closed("closed");
  goal.reason = CONTINUATION_REASONS.checkpoint;
  return closed("continue");
}

/** Disconnect/restart revokes future runs; any ongoing run retains its physical and cost binding. */
export function pauseGoalForPolicy(previous: GoalState, reason: string, now: number): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = state.current;
  if (goal === undefined || goal.status !== "active") return state;
  goal.status = "paused";
  goal.reason = reason;
  goal.control_revision = state.revision + 1;
  return changed(state, goal, now);
}

/** Fail closed before admission when the host cannot reserve both stage budget partitions. */
export function limitGoalForVerificationBudget(
  previous: GoalState,
  input: { goal_id: string; control_revision: number; reason: string; now: number },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = state.current;
  if (
    goal?.goal_id !== input.goal_id ||
    goal.status !== "active" ||
    goal.control_revision !== input.control_revision ||
    goalHasPhysicalRun(goal)
  )
    return state;
  goal.status = "budget_limited";
  goal.reason = input.reason;
  goal.control_revision = state.revision + 1;
  return changed(state, goal, input.now);
}

/**
 * Stop a host-owned stage or its pending preparation without overwriting a newer stage/control.
 * The previous execution permits revocation before the new intent is committed. A superseding
 * human admission keeps its own authority; this operation never claims physical closure.
 */
export function stopGoalContinuation(
  previous: GoalState,
  input: {
    goal_id: string;
    execution_id: string;
    previous_execution_id?: string;
    control_revision: number;
    reason: "revoked" | "failed";
    now: number;
  },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = state.current;
  if (
    goal?.goal_id !== input.goal_id ||
    goal.status !== "active" ||
    goal.control_revision !== input.control_revision
  )
    return state;
  const latest = goal.runs.at(-1)?.execution_id;
  if (
    latest !== input.execution_id &&
    (goal.runs.some((run) => run.execution_id === input.execution_id) ||
      latest !== input.previous_execution_id)
  )
    return state;
  goal.status = input.reason === "revoked" ? "paused" : "blocked";
  goal.reason =
    input.reason === "revoked"
      ? "Conversation controller retired; explicit resume is required"
      : "Host could not admit the next goal stage; intervention is required";
  goal.control_revision = state.revision + 1;
  return changed(state, goal, input.now);
}
