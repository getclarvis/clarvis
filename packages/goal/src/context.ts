import type { GoalRuntimeSnapshot } from "./ports.ts";

export const GOAL_BLOCK_KIND = "goal";

/** Model-facing projection excludes the session audit and private operation receipts. */
export function goalModelView({ goal, evidence }: GoalRuntimeSnapshot): Record<string, unknown> {
  const run = goal.runs.at(-1);
  return {
    goal_id: goal.goal_id,
    revision: goal.revision,
    objective_revision: goal.objective_revision,
    objective: goal.objective,
    criteria:
      goal.criteria.length === 0
        ? [{ id: "objective", kind: "qualitative", description: goal.objective }]
        : goal.criteria,
    status: goal.status,
    reason: goal.reason,
    limits: goal.limits,
    consumption: goal.consumption,
    auto_continuations: goal.auto_continuations,
    no_progress_checkpoints: goal.no_progress_checkpoints,
    progress: run?.progress,
    checkpoint: run?.checkpoint,
    evidence,
    accepted_human_criteria: goal.human_acceptances
      .filter((acceptance) => acceptance.objective_revision === goal.objective_revision)
      .map((acceptance) => acceptance.criterion_id),
  };
}

/** Compact current reminder for a named stable block; old publications remain historical. */
export function goalContextBlock({ goal }: GoalRuntimeSnapshot): string {
  const criteria = goal.criteria.map((criterion) => ({
    id: criterion.id,
    kind: criterion.kind,
    description: criterion.description.slice(0, 192),
  }));
  return [
    "<goal>",
    "The latest goal reminder describes current state; prior reminders are history. " +
      "The host store controls authority. Use get_goal for the complete objective and criteria.",
    JSON.stringify({
      goal_id: goal.goal_id,
      objective_revision: goal.objective_revision,
      objective: goal.objective.slice(0, 4096),
      criteria: criteria.length === 0 ? [{ id: "objective", kind: "qualitative" }] : criteria,
      status: goal.status,
    }),
    "Pass one update object to update_goal: progress to record work, checkpoint with summary and next_step to request " +
      "a stage ending, or candidate with every criterion before the normal final answer. " +
      "Checkpoint preserves open plan tasks; plan review and child settlement still apply. " +
      "Qualitative judgments are model assessments; human acceptance comes only from the user. " +
      "Evidence IDs come from the host. Report blocked when a decision, authorization or resource " +
      "is missing. Checkpoint and candidate never authorize another run or more budget.",
    "</goal>",
  ].join("\n");
}
