import { createGoalUsageTracker } from "./usage.ts";
import type { ProviderConfig } from "@clarvis/capability";
import {
  runGoalAgent,
  GoalAgentRunFailure,
  type GoalAgentRunInput,
  type GoalAgentRunResult,
} from "@clarvis/goal";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { RunExecutor } from "../runs/run-service.ts";

export interface KernelGoalAgentRuntimeOptions {
  owner: string;
  model: string;
  providers: ProviderConfig[];
  deps: ExecuteRunDeps;
  executeRun: RunExecutor;
}

/** Replace the host capability surface with its canonical tools capability only. */
export function createKernelGoalAgentRuntime(options: KernelGoalAgentRuntimeOptions): {
  workspaceReadAvailable: boolean;
  run(input: GoalAgentRunInput): Promise<GoalAgentRunResult>;
} {
  const tools = (options.deps.capabilities ?? []).filter(
    (capability) => capability.name === "tools",
  );
  const maxGrant = options.deps.env.CLARVIS_AGENT_TOOLS_MAX_GRANT;
  const workspaceReadAvailable =
    options.deps.env.CLARVIS_AGENT_TOOLS_ENABLED === true &&
    tools.length === 1 &&
    maxGrant !== "none";
  const deps: ExecuteRunDeps = { ...options.deps, capabilities: tools };
  return {
    workspaceReadAvailable,
    async run(input) {
      const tracker = createGoalUsageTracker();
      try {
        const result = await runGoalAgent(
          {
            owner: options.owner,
            model_ref: options.model,
            providers: options.providers,
            execute_run: options.executeRun,
            deps: { ...deps, llm: tracker.wrap(deps.llm) },
          },
          input,
        );
        return { ...result, usage: tracker.measure(), accounting: tracker.accounting() };
      } catch (error) {
        throw new GoalAgentRunFailure(
          input.execution_id,
          tracker.measure(),
          error instanceof GoalAgentRunFailure ? error.message : "failed",
          tracker.accounting(),
        );
      }
    },
  };
}
