import { boundedGoalState } from "./control.ts";
import { GoalError } from "./errors.ts";
import {
  GOAL_VERIFICATIONS_MAX,
  goalVerificationSchema,
  type GoalRecord,
  type GoalState,
  type GoalVerification,
} from "./schemas.ts";
import { goalCandidateDigest, goalDefinitionDigest } from "./agent/verification.ts";

export interface GoalVerificationFence {
  goal_id: string;
  execution_id: string;
  control_revision: number;
  objective_revision: number;
  definition_digest: string;
  candidate_digest: string;
  final_attempt_digest: string;
  evidence_digest: string;
}

/** Locate a persisted proof only when every host-owned completion fence still matches. */
export function currentGoalVerification(
  goal: GoalRecord,
  fence: GoalVerificationFence,
): GoalVerification | undefined {
  if (
    goal.goal_id !== fence.goal_id ||
    goal.control_revision !== fence.control_revision ||
    goal.objective_revision !== fence.objective_revision ||
    goalDefinitionDigest(goal) !== fence.definition_digest ||
    goal.candidate === undefined ||
    goalCandidateDigest(goal.candidate) !== fence.candidate_digest
  )
    return undefined;
  const verifications = goal.runs.find(
    (run) => run.execution_id === fence.execution_id,
  )?.verifications;
  if (verifications === undefined) return undefined;
  for (let index = verifications.length - 1; index >= 0; index--) {
    const verification = verifications[index]!;
    if (
      verification.control_revision === fence.control_revision &&
      verification.objective_revision === fence.objective_revision &&
      verification.definition_digest === fence.definition_digest &&
      verification.candidate_digest === fence.candidate_digest &&
      verification.final_attempt_digest === fence.final_attempt_digest &&
      verification.evidence_digest === fence.evidence_digest
    )
      return verification;
  }
  return undefined;
}

/** Persist an independently produced verdict without granting it completion authority. */
export function recordGoalVerification(
  previous: GoalState,
  input: GoalVerificationFence & { verification: GoalVerification; now: number },
): GoalState {
  const state = boundedGoalState(previous, true);
  const goal = state.current;
  const run = goal?.runs.find((value) => value.execution_id === input.execution_id);
  const verification = goalVerificationSchema.parse(input.verification);
  if (
    goal === undefined ||
    run === undefined ||
    run.phase !== "running" ||
    currentGoalVerification(goal, input) !== undefined ||
    goal.goal_id !== input.goal_id ||
    goal.control_revision !== input.control_revision ||
    goal.objective_revision !== input.objective_revision ||
    goalDefinitionDigest(goal) !== input.definition_digest ||
    goal.candidate === undefined ||
    goalCandidateDigest(goal.candidate) !== input.candidate_digest ||
    verification.control_revision !== input.control_revision ||
    verification.objective_revision !== input.objective_revision ||
    verification.definition_digest !== input.definition_digest ||
    verification.candidate_digest !== input.candidate_digest ||
    verification.final_attempt_digest !== input.final_attempt_digest ||
    verification.evidence_digest !== input.evidence_digest
  )
    throw new GoalError("conflict", "Goal changed before verification was persisted");
  run.verifications.push(verification);
  if (run.verifications.length > GOAL_VERIFICATIONS_MAX)
    run.verifications.splice(0, run.verifications.length - GOAL_VERIFICATIONS_MAX);
  state.revision += 1;
  goal.revision = state.revision;
  goal.updated_at = input.now;
  return boundedGoalState(state, true);
}
