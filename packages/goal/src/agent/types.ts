import type { PerAgentUsage } from "@clarvis/capability";
import type { ProviderConfig } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import type { GoalUsage } from "../schemas.ts";

export type GoalFormulationMode = "auto" | "guided";

export interface GoalTrajectoryInput {
  projection: string;
  digest: string;
  truncated: boolean;
  source_execution_ids: string[];
  workspace_read_available: boolean;
}

export interface GoalAgentRuntime {
  owner: string;
  model_ref: string;
  providers: ProviderConfig[];
  execute_run: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>;
  deps: GoalAgentRunDeps;
}

export type GoalAgentRunDeps = ExecuteRunDeps;

export interface GoalAgentRunInput {
  mode: GoalFormulationMode;
  seed?: string;
  trajectory: GoalTrajectoryInput;
  execution_id: string;
  agent_instance_id: string;
  session_id: string;
  signal?: AbortSignal;
  budget?: Partial<GoalAgentBudget>;
}

export interface GoalAgentBudget {
  max_net_tokens: number;
  timeout_ms: number;
  max_iterations: number;
  call_timeout_ms: number;
  max_retries: number;
}

export interface GoalAgentRunResult {
  execution_id: string;
  result: GoalFormulationResult;
  usage: GoalUsage;
  elapsed_ms: number;
  accounting?: PerAgentUsage[];
}

export type GoalFormulationResult =
  | {
      status: "ready";
      objective: string;
      criteria: Array<{ description: string; kind: "qualitative" | "human" }>;
      constraints: string[];
      exclusions: string[];
      assumptions: string[];
      normative_source_paths: string[];
    }
  | { status: "insufficient_context"; question: string; reason: string };
