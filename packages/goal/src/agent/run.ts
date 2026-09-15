import type { Usage } from "@clarvis/capability";
import { buildGoalAgentRequest, goalFormulationResultSchema } from "./request.ts";
import type { GoalAgentRunInput, GoalAgentRunResult, GoalAgentRuntime } from "./types.ts";

function measuredUsage(usage: Usage): GoalAgentRunResult["usage"] {
  const input = usage.by_agent.reduce((sum, row) => sum + row.input_tokens, 0);
  const output = usage.by_agent.reduce((sum, row) => sum + row.output_tokens, 0);
  const cached = usage.by_agent.reduce((sum, row) => sum + row.cached_tokens, 0);
  return { kind: "measured", input, output, cached };
}

/** A terminal formulation failure that retains only host accounting, never model payloads. */
export class GoalAgentRunFailure extends Error {
  constructor(
    readonly execution_id: string,
    readonly usage: GoalAgentRunResult["usage"],
    status: string,
  ) {
    super(`Goal formulation run ended with ${status}`);
    this.name = "GoalAgentRunFailure";
  }
}

/** Execute one isolated semantic run and accept only a completed, schema-valid submission. */
export async function runGoalAgent(
  runtime: GoalAgentRuntime,
  input: GoalAgentRunInput,
): Promise<GoalAgentRunResult> {
  const started = performance.now();
  const outcome = await runtime.execute_run({
    rawBody: buildGoalAgentRequest(runtime, input),
    owner: runtime.owner,
    deps: runtime.deps,
    callPurpose: "goal",
    externalSignal: input.signal,
  });
  const usage = measuredUsage(outcome.response.usage);
  if (outcome.response.status !== "completed")
    throw new GoalAgentRunFailure(outcome.executionId, usage, outcome.response.status);
  let result: GoalAgentRunResult["result"];
  try {
    result = goalFormulationResultSchema.parse(outcome.response.result);
  } catch {
    throw new GoalAgentRunFailure(outcome.executionId, usage, "invalid_result");
  }
  return {
    execution_id: outcome.executionId,
    result,
    usage,
    elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
  };
}
