import type { RunRequest } from "@clarvis/capability";
import { GOAL_STEWARD_PROMPT } from "./steward-prompt.ts";
import {
  type GoalStewardMode,
  type GoalStewardRunInput,
  type GoalStewardRuntime,
} from "./steward-types.ts";

export const GOAL_STEWARD_INSTANCE = "goal-steward";
/**
 * Advertise only the operation's verdicts and optional commentary.
 *
 * @remarks The private result gate owns verdict validation and its one correction.
 *   Permissive property shapes let missing or malformed verdicts reach that gate
 *   instead of entering the generic loop's schema-rejection path. Commentary is
 *   advisory and must never prevent a recognized verdict from reaching settlement.
 */
export function goalStewardOutputSchema(mode: GoalStewardMode): Record<string, unknown> {
  const choices =
    mode === "definition"
      ? "accept_definition, revise_definition"
      : "achieved, needs_work, needs_evidence";
  return {
    type: "object",
    properties: {
      verdict: { description: `Required decision. Choose exactly one of: ${choices}.` },
      message: {
        description:
          "Optional text: explain acceptance, the work to do, or the specific question to answer.",
      },
    },
  };
}

/** Stable profile, catalog and identity; only a new frame and execution id vary. */
export function buildGoalStewardRequest(
  runtime: Pick<GoalStewardRuntime, "model_ref" | "providers" | "reasoning_effort">,
  input: GoalStewardRunInput,
): RunRequest {
  if (
    !Number.isSafeInteger(input.budget.max_net_tokens) ||
    input.budget.max_net_tokens <= 0 ||
    Buffer.byteLength(input.projection, "utf8") > 512 * 1024
  )
    throw new Error("Invalid Goal Steward budget or frame bound");
  return {
    execution_id: input.execution_id,
    session_id: input.session_id,
    agent_instance_id: GOAL_STEWARD_INSTANCE,
    ...(input.continue_from === undefined ? {} : { continue_from: input.continue_from }),
    messages: [{ role: "user", content: input.projection }],
    servers: [],
    providers: runtime.providers,
    profiles: [
      {
        name: GOAL_STEWARD_INSTANCE,
        model: runtime.model_ref,
        ...(runtime.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: runtime.reasoning_effort }),
        base_prompt: GOAL_STEWARD_PROMPT,
        tools: [],
        grants: [],
        can_spawn: [],
        iteration_limit: input.budget.max_iterations,
        call_timeout_ms: input.budget.call_timeout_ms,
        retry: {
          max_retries: input.budget.max_retries,
          max_retry_after_ms: input.budget.call_timeout_ms,
        },
        compaction: { enabled: true, prompt_mode: "summarize" },
      },
    ],
    entry: GOAL_STEWARD_INSTANCE,
    shared_prompt: "",
    budget: {
      on_exceed: "stop",
      total_token_limit: input.budget.max_net_tokens,
      timeout_ms: input.budget.timeout_ms,
    },
    output_schema: goalStewardOutputSchema(input.mode),
    prompt_cache_ttl: input.prompt_cache_ttl,
    elicit_wait_ms: 0,
  };
}
