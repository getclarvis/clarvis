import { z } from "zod";
import type { AgentProfile, BudgetConfig, ProviderConfig, RunRequest } from "@clarvis/capability";

const discard = z
  .unknown()
  .optional()
  .transform(() => undefined);
const positive = z.number().int().positive();
const profile = z
  .object({
    name: z.literal("judge"),
    description: discard,
    model: z.string().min(1),
    base_prompt: discard,
    tools: z.array(z.never()),
    grants: z.array(z.never()).optional(),
    can_spawn: z.array(z.never()).optional(),
    default_spawn: z.undefined().optional(),
    iteration_limit: positive.optional(),
    stagnation_threshold: discard,
    call_timeout_ms: positive.optional(),
    reasoning_summary: discard,
    reasoning_effort: discard,
    retry: discard,
    compaction: discard,
    orchestration: discard,
  } satisfies Record<keyof AgentProfile, z.ZodType>)
  .strict()
  .transform((value): AgentProfile => ({
    name: "judge",
    model: value.model,
    tools: [],
    iteration_limit: value.iteration_limit ?? 1,
    ...(value.call_timeout_ms === undefined ? {} : { call_timeout_ms: value.call_timeout_ms }),
    compaction: { enabled: false },
  }));
const provider = z
  .object({
    name: z.string().min(1),
    kind: z.enum([
      "openai-compatible",
      "openai",
      "anthropic",
      "google",
      "openai-codex",
      "xai-grok",
    ]),
    base_url: z
      .string()
      .transform(() => "https://redacted.invalid")
      .optional(),
    api_key_env: discard,
    headers: discard,
    body: discard,
    models: discard,
  } satisfies Record<keyof ProviderConfig, z.ZodType>)
  .strict();
const budget = z
  .object({
    on_exceed: z.literal("stop"),
    total_token_limit: positive,
    timeout_ms: positive.optional(),
    max_escalations: z.undefined().optional(),
  } satisfies Record<keyof BudgetConfig, z.ZodType>)
  .strict();
const request = z
  .object({
    execution_id: z.string().min(1).optional(),
    continue_from: z.undefined().optional(),
    session_id: z.string().min(1),
    agent_instance_id: z.literal("judge"),
    prompt_cache_ttl: z.enum(["5m", "1h"]),
    messages: z
      .array(z.unknown())
      .min(1)
      .transform(() => [{ role: "user" as const, content: "[private judge request]" }]),
    servers: z.array(z.never()),
    profiles: z.array(profile).length(1),
    entry: z.literal("judge"),
    shared_prompt: z
      .string()
      .optional()
      .transform(() => ""),
    vision_model: z.undefined().optional(),
    budget,
    providers: z.array(provider),
    output_schema: z.undefined().optional(),
    elicit_wait_ms: z.undefined().optional(),
    guard_escalation: z.literal(false).optional(),
    agents: z.undefined().optional(),
    guard_mode: z.undefined().optional(),
    hook_user_prompt_expansion: z.undefined().optional(),
  } satisfies Record<keyof RunRequest, z.ZodType>)
  .strict();

/** Rebuild a structurally valid private request while removing all prompts and provider secrets. */
export function projectJudgeRequest(value: RunRequest): RunRequest {
  return request.parse(value);
}
