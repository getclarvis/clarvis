import type { ProviderConfig } from "@clarvis/capability";
import { runGoalAgent, type GoalAgentRunInput, type GoalAgentRunResult } from "@clarvis/goal";
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
    run: (input) =>
      runGoalAgent(
        {
          owner: options.owner,
          model_ref: options.model,
          providers: options.providers,
          execute_run: options.executeRun,
          deps,
        },
        input,
      ),
  };
}
