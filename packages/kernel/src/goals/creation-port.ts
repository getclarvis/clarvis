import type { GoalCreationPort } from "@clarvis/goal";
import { createCreationLifecycle } from "./creation-port-lifecycle.ts";
import type { GoalCreationPortOptions } from "./creation-port-types.ts";

/** Build the host bridge for the first main-agent turn without mixing it with Goal domain rules. */
export function createGoalCreationPort(options: GoalCreationPortOptions): GoalCreationPort {
  const now = options.now ?? Date.now;
  const lifecycle = createCreationLifecycle(options, now);

  return {
    session_id: options.session.id,
    agent_instance_id: options.agentInstanceId,
    execution_id: options.executionId,
    create: (input, signal) => lifecycle.create(input, signal),
  };
}
