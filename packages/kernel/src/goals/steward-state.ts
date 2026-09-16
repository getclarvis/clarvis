import { boundedGoalState, type GoalRuntimeBinding, type GoalState } from "@clarvis/goal";

/** Short host-owned transactions fence effects without holding a lock during inference. */
export function stewardBound(state: GoalState | undefined, binding: GoalRuntimeBinding) {
  if (state === undefined) throw new Error("Goal Steward state is absent");
  const next = boundedGoalState(state, true);
  const goal = next.current;
  const run = goal?.runs.at(-1);
  if (
    !goal ||
    !run ||
    goal.goal_id !== binding.goal_id ||
    goal.objective_revision !== binding.objective_revision ||
    run.execution_id !== binding.execution_id ||
    goal.status !== "active" ||
    (run.phase !== "running" && run.phase !== "settling")
  )
    throw new Error("Goal Steward binding is stale");
  return { state: next, goal, run };
}
