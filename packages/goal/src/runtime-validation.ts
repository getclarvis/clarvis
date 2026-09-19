import { z } from "zod";
import { GoalError } from "./errors.ts";
import type { GoalRuntimeBinding, GoalRuntimeSnapshot } from "./ports.ts";
import { goalEvidenceRefSchema, goalRecordSchema } from "./schemas.ts";

export const absentReviewContext = { snapshot: () => ({ revision: "absent", contexts: [] }) };

const snapshotSchema = z
  .object({
    goal: goalRecordSchema,
    evidence: z.array(goalEvidenceRefSchema.extend({ description: z.string().max(512) })).max(32),
  })
  .strict();

/** Reject stale or foreign snapshots before a model-facing Goal operation can proceed. */
export function checkGoalSnapshot(
  value: GoalRuntimeSnapshot,
  binding: GoalRuntimeBinding,
  preparing = false,
): GoalRuntimeSnapshot {
  const snapshot = snapshotSchema.parse(value);
  const { goal, evidence } = snapshot;
  const run = goal.runs.at(-1);
  if (
    goal.goal_id !== binding.goal_id ||
    goal.session_id !== binding.session_id ||
    goal.objective_revision !== binding.objective_revision ||
    (goal.status !== "active" && goal.status !== "paused") ||
    run?.execution_id !== binding.execution_id ||
    run.objective_revision !== binding.objective_revision ||
    (run.phase !== "running" && !(preparing && run.phase === "preparing")) ||
    (run.phase === "preparing" &&
      (goal.status !== "active" || run.control_revision !== goal.control_revision)) ||
    evidence.some(
      (reference) =>
        reference.goal_id !== goal.goal_id ||
        reference.objective_revision !== goal.objective_revision ||
        !goal.runs.some(
          (source) =>
            source.execution_id === reference.execution_id &&
            source.objective_revision === goal.objective_revision,
        ),
    )
  )
    throw new GoalError("conflict", "Goal capability is outside its bound execution");
  return snapshot;
}
