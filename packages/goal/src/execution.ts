import { GoalError } from "./errors.ts";
import { boundedGoalState } from "./control.ts";
import { goalAdmission, goalDeadlineLimit, goalNetTokens } from "./policy.ts";
import {
  goalCandidateSchema,
  goalCheckpointSchema,
  goalProgressSchema,
  goalUsageSchema,
  type GoalCandidate,
  type GoalCheckpoint,
  type GoalProgress,
  type GoalRecord,
  type GoalRun,
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
    goal.reason = "Physical execution outcome is unknown; host recovery is required";
  }
  return changed(state, goal, input.now);
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
 * Persist a bound stage's blocker without overriding a newer user pause/cancel or physical state.
 * A repeated block is idempotent. This does not terminate the process or settle its eventual usage.
 */
export function blockGoalRun(
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
    throw new GoalError("conflict", "Blocker belongs to an obsolete goal revision");
  if (goal.status !== "active") return state;
  if (run.phase !== "running")
    throw new GoalError("conflict", "Blocker requires the bound running stage");
  goal.reason = goalProgressSchema.shape.summary.parse(input.reason);
  goal.status = "blocked";
  goal.control_revision = state.revision + 1;
  return changed(state, goal, input.now);
}

function reconcileUsage(goal: GoalRecord): void {
  const totals: GoalRecord["consumption"] = {
    input: 0,
    output: 0,
    cached: 0,
    net_tokens: 0,
    usage_unknown: false,
    cache_estimated: false,
    overrun_tokens: 0,
  };
  for (const run of goal.runs) {
    if (run.phase !== "closed") continue;
    if (run.usage === undefined || run.usage.kind === "unknown") {
      totals.usage_unknown = true;
      continue;
    }
    totals.input += run.usage.input;
    totals.output += run.usage.output;
    totals.net_tokens += goalNetTokens(run.usage)!;
    if (run.usage.cached === undefined && run.usage.input > 0) {
      delete totals.cached;
      totals.cache_estimated = true;
    } else if (totals.cached !== undefined) totals.cached += run.usage.cached ?? 0;
  }
  totals.overrun_tokens = Math.max(0, totals.net_tokens - goal.limits.max_net_tokens);
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
 * Reconcile only after physical closure. Late usage always belongs to the original binding,
 * even after pause/cancel; status changes require the still-current control/objective revision.
 * Missing telemetry blocks continuation, and a checkpoint never turns a failed run into success.
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
    if (run.usage?.kind !== "unknown" || usage.kind !== "measured")
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
  reconcileUsage(goal);
  const deadline = goalDeadlineLimit(goal, input.now);
  if (
    goal.status !== "active" ||
    run.control_revision !== goal.control_revision ||
    run.objective_revision !== goal.objective_revision
  )
    return changed(state, goal, input.now);
  if (goal.consumption.usage_unknown) {
    goal.status = "blocked";
    goal.reason = "Usage is unknown; reconcile it before resuming";
  } else if (deadline !== undefined) {
    goal.status = deadline.status;
    goal.reason = deadline.reason;
  } else if (input.outcome !== "completed") {
    const decision = goalAdmission(goal, input.now, false);
    if (!decision.allowed && decision.status === "budget_limited") {
      goal.status = decision.status;
      goal.reason = decision.reason;
    } else {
      goal.status = "blocked";
      goal.reason = input.outcome === "cancelled" ? "Goal run was cancelled" : "Goal run failed";
    }
  } else if (input.disposition === "final") {
    if (
      input.completion_validated &&
      run.candidate !== undefined &&
      run.candidate.objective_revision === goal.objective_revision
    ) {
      goal.status = "complete";
      goal.reason = "Completion committed after criteria, gates and durable reconciliation";
    } else {
      goal.status = "blocked";
      goal.reason = "Run ended without a validated completion candidate or checkpoint";
    }
  } else if (run.checkpoint === undefined) {
    goal.status = "blocked";
    goal.reason = "Run ended without an accepted checkpoint";
  } else {
    goal.no_progress_checkpoints = run.checkpoint.progress_accepted
      ? 0
      : goal.no_progress_checkpoints + 1;
    const decision = goalAdmission(goal, input.now, true);
    if (!decision.allowed) {
      goal.status = decision.status;
      goal.reason = decision.reason;
    }
  }
  return changed(state, goal, input.now);
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
