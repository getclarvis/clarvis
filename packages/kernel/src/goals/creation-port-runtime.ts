import type { GoalRuntimePort } from "@clarvis/goal";
import { createGoalRuntimePort } from "./runtime-port.ts";
import type { GoalCreationPortOptions } from "./creation-port-types.ts";

export async function bindCreatedGoalRuntime(
  options: GoalCreationPortOptions,
  now: () => number,
): Promise<GoalRuntimePort> {
  const state = await options.repository.read(options.session.id);
  const goal = state?.current;
  if (goal === undefined) throw new Error("Goal creation did not persist a current goal");
  return createGoalRuntimePort({
    repository: options.repository,
    binding: {
      session_id: options.session.id,
      agent_instance_id: options.agentInstanceId,
      execution_id: options.executionId,
      goal_id: goal.goal_id,
      objective_revision: goal.objective_revision,
    },
    evidence: options.evidence,
    signal: options.signal,
    now,
    onChange: () => options.onChange?.(options.session.id),
  });
}

export function assertCreationAlive(options: GoalCreationPortOptions, signal?: AbortSignal): void {
  options.signal?.throwIfAborted();
  signal?.throwIfAborted();
}
