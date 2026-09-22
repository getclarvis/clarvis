import type { PerAgentUsage } from "@clarvis/capability";
import type {
  GoalStewardRuntime,
  GoalStewardRunInput,
  GoalStewardRunResult,
} from "./steward-types.ts";
import { goalStewardResultSchema } from "./steward-types.ts";
import { buildGoalStewardRequest } from "./steward-request.ts";

/** Retain terminal usage on failures without exposing the model's payload in diagnostics. */
export class GoalStewardRunFailure extends Error {
  constructor(
    readonly execution_id: string,
    readonly usage: GoalStewardRunResult["usage"],
    readonly code = "goal_steward_failed",
    readonly accounting?: PerAgentUsage[],
  ) {
    super("goal_steward_failed");
    this.name = "GoalStewardRunFailure";
  }
}

/** One ordinary isolated run; the host owns independent accounting and cancellation. */
export async function runGoalSteward(
  runtime: GoalStewardRuntime,
  input: GoalStewardRunInput,
): Promise<GoalStewardRunResult> {
  const started = performance.now();
  const outcome = await runtime.execute_run({
    rawBody: buildGoalStewardRequest(runtime, input),
    owner: runtime.owner,
    deps: runtime.deps,
    callPurpose: "goal",
    externalSignal: input.signal,
  });
  const rows = outcome.response.usage.by_agent;
  const usage: GoalStewardRunResult["usage"] = {
    kind: "complete",
    input: rows.reduce((sum, row) => sum + row.input_tokens, 0),
    output: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    cached: rows.reduce((sum, row) => sum + row.cached_tokens, 0),
  };
  if (outcome.response.status !== "completed")
    throw new GoalStewardRunFailure(
      outcome.executionId,
      usage,
      outcome.response.status === "error" ? outcome.response.error.code : outcome.response.status,
    );
  const parsed = goalStewardResultSchema.safeParse(outcome.response.result);
  if (!parsed.success) throw new GoalStewardRunFailure(outcome.executionId, usage);
  return {
    execution_id: outcome.executionId,
    result: parsed.data,
    usage,
    elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
  };
}
