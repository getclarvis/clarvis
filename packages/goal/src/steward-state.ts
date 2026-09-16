import { boundedGoalState } from "./control.ts";
import { goalNetTokens } from "./policy.ts";
import type { GoalRuntimeBinding } from "./ports.ts";
import type { GoalState, GoalStewardReview, GoalUsage } from "./schemas.ts";

/** Charge every admitted evaluation exactly once, including stale and failed outcomes. */
export function settleStewardEvaluation(
  previous: GoalState,
  input: {
    binding: GoalRuntimeBinding;
    executionId: string;
    usage: GoalUsage;
    review?: GoalStewardReview;
    sequence: number;
    trajectoryDigest?: string;
    steeringEpoch?: number;
    fingerprint: string;
    now: number;
    continued: boolean;
    controlRevision: number;
  },
): { state: GoalState; charged: boolean } {
  const state = boundedGoalState(previous, true);
  const goal = [state.current, ...state.archive].find(
    (goal) => goal?.goal_id === input.binding.goal_id,
  );
  if (!goal || goal.steward.pending_execution_id !== input.executionId)
    return { state, charged: false };
  const chain = goal.steward;
  delete chain.pending_execution_id;
  if (input.usage.kind === "unknown") chain.consumption.usage_unknown = true;
  else {
    chain.consumption.input += input.usage.input;
    chain.consumption.output += input.usage.output;
    chain.consumption.net_tokens += goalNetTokens(input.usage) ?? 0;
    if (input.usage.cached === undefined) delete chain.consumption.cached;
    else if (chain.consumption.cached !== undefined) chain.consumption.cached += input.usage.cached;
  }
  const run = goal.runs.find((run) => run.execution_id === input.binding.execution_id)!;
  if (
    input.continued &&
    goal.status === "active" &&
    goal.control_revision === input.controlRevision &&
    goal.objective_revision === input.binding.objective_revision
  ) {
    chain.last_steward_execution_id = input.executionId;
    chain.last_consumed_work_sequence = input.sequence;
    chain.runtime_fingerprint = input.fingerprint;
    chain.trajectory_digest = input.trajectoryDigest;
    chain.operator_steering_epoch = input.steeringEpoch ?? chain.operator_steering_epoch;
  } else delete chain.last_steward_execution_id;
  if (
    input.review !== undefined &&
    goal.status === "active" &&
    goal.control_revision === input.review.control_revision &&
    goal.objective_revision === input.review.objective_revision
  ) {
    run.steward_reviews = [...run.steward_reviews, input.review].slice(-8);
    chain.last_steward_execution_id = input.executionId;
    chain.last_consumed_work_sequence = input.sequence;
    chain.runtime_fingerprint = input.fingerprint;
    chain.trajectory_digest = input.trajectoryDigest;
    chain.operator_steering_epoch = input.steeringEpoch ?? chain.operator_steering_epoch;
    chain.status =
      input.review.decision === "achieved"
        ? "verified"
        : input.review.decision === "aligned"
          ? "aligned"
          : input.review.decision === "new_run"
            ? "new_run_recommended"
            : input.review.decision === "steer"
              ? "intervened"
              : "attention";
  } else {
    chain.status = "attention";
  }
  state.revision++;
  goal.revision = state.revision;
  goal.updated_at = input.now;
  return { state: boundedGoalState(state, true), charged: true };
}
