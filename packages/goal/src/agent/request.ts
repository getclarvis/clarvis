import { z } from "zod";
import { createHash } from "node:crypto";
import type { AgentProfile, RunRequest } from "@clarvis/capability";
import type { GoalCriterion } from "../schemas.ts";
import type {
  GoalAgentBudget,
  GoalAgentRunInput,
  GoalAgentRuntime,
  GoalFormulationResult,
} from "./types.ts";
import { goalAgentPrompt } from "./prompt.ts";

export const GOAL_GUIDED_SEED_MAX_CHARS = 16_384;
export const GOAL_FORMULATION_DEFAULTS: GoalAgentBudget = {
  max_net_tokens: 160_000_000,
  timeout_ms: 120_000,
  max_iterations: 8,
  call_timeout_ms: 60_000,
  max_retries: 1,
};

const text = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .transform((value) => value.replace(/\s+/gu, " "));
const semanticList = z.array(text).max(16);
const noSemanticDuplicates = (values: string[]): boolean =>
  new Set(values.map((value) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase())).size ===
  values.length;

const ready = z
  .object({
    status: z.literal("ready"),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(GOAL_GUIDED_SEED_MAX_CHARS)
      .transform((value) => value.replace(/\s+/gu, " ")),
    criteria: z
      .array(z.object({ description: text, kind: z.enum(["qualitative", "human"]) }).strict())
      .max(32),
    constraints: semanticList,
    exclusions: semanticList,
    assumptions: semanticList,
    normative_source_paths: z.array(z.string().trim().min(1).max(4096)).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of [
      "constraints",
      "exclusions",
      "assumptions",
      "normative_source_paths",
    ] as const)
      if (!noSemanticDuplicates(value[key]))
        ctx.addIssue({ code: "custom", path: [key], message: `${key} contains duplicates` });
    if (!noSemanticDuplicates(value.criteria.map((criterion) => criterion.description)))
      ctx.addIssue({ code: "custom", path: ["criteria"], message: "criteria contains duplicates" });
    const definitionItems = [...value.constraints, ...value.exclusions, ...value.assumptions];
    if (!noSemanticDuplicates(definitionItems))
      ctx.addIssue({
        code: "custom",
        path: ["constraints"],
        message: "semantic definition contains duplicates",
      });
  });

const insufficient = z
  .object({ status: z.literal("insufficient_context"), question: text, reason: text })
  .strict();

export const goalFormulationResultSchema = z.discriminatedUnion("status", [ready, insufficient]);

export const goalFormulateInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto"), seed: z.never().optional() }).strict(),
  z
    .object({
      mode: z.literal("guided"),
      seed: z.string().trim().min(1).max(GOAL_GUIDED_SEED_MAX_CHARS),
    })
    .strict(),
]);

const operationId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);

export const goalFormulateRequestSchema = z
  .object({
    session_id: operationId,
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    operation_id: operationId,
    mode: z.enum(["auto", "guided"]),
    seed: z.string().trim().min(1).max(GOAL_GUIDED_SEED_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "auto" && value.seed !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["seed"],
        message: "auto formulation cannot carry a seed",
      });
    if (value.mode === "guided" && value.seed === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["seed"],
        message: "guided formulation requires a seed",
      });
  })
  .transform((value) =>
    value.mode === "auto"
      ? {
          session_id: value.session_id,
          expected_revision: value.expected_revision,
          operation_id: value.operation_id,
          mode: "auto" as const,
        }
      : {
          session_id: value.session_id,
          expected_revision: value.expected_revision,
          operation_id: value.operation_id,
          mode: "guided" as const,
          seed: value.seed!,
        },
  );

export type ParsedGoalFormulateRequest = z.output<typeof goalFormulateRequestSchema>;

export function goalFormulationFingerprint(request: ParsedGoalFormulateRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export const goalFormulationOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "objective",
        "criteria",
        "constraints",
        "exclusions",
        "assumptions",
        "normative_source_paths",
      ],
      properties: {
        status: { const: "ready" },
        objective: { type: "string", minLength: 1, maxLength: GOAL_GUIDED_SEED_MAX_CHARS },
        criteria: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "kind"],
            properties: {
              description: { type: "string", minLength: 1, maxLength: 4096 },
              kind: { enum: ["qualitative", "human"] },
            },
          },
        },
        constraints: stringArraySchema(),
        exclusions: stringArraySchema(),
        assumptions: stringArraySchema(),
        normative_source_paths: stringArraySchema(4096),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "question", "reason"],
      properties: {
        status: { const: "insufficient_context" },
        question: { type: "string", minLength: 1, maxLength: 4096 },
        reason: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
  ],
} as const;

function stringArraySchema(maxLength = 4096) {
  return {
    type: "array",
    maxItems: 16,
    items: { type: "string", minLength: 1, maxLength },
  } as const;
}

function bounded(input: GoalAgentRunInput): GoalAgentBudget {
  const requested = { ...GOAL_FORMULATION_DEFAULTS, ...input.budget };
  return {
    max_net_tokens: requested.max_net_tokens,
    timeout_ms: Math.min(requested.timeout_ms, GOAL_FORMULATION_DEFAULTS.timeout_ms),
    max_iterations: Math.min(requested.max_iterations, GOAL_FORMULATION_DEFAULTS.max_iterations),
    call_timeout_ms: Math.min(requested.call_timeout_ms, GOAL_FORMULATION_DEFAULTS.call_timeout_ms),
    max_retries: Math.min(requested.max_retries, GOAL_FORMULATION_DEFAULTS.max_retries),
  };
}

/** Build the immutable, read-only semantic-agent run request. */
export function buildGoalAgentRequest(
  runtime: Pick<GoalAgentRuntime, "model_ref" | "providers">,
  input: GoalAgentRunInput,
): RunRequest {
  const parsed = goalFormulateInputSchema.parse(
    input.mode === "auto" ? { mode: input.mode } : { mode: input.mode, seed: input.seed },
  );
  const budget = bounded(input);
  const profile: AgentProfile = {
    name: "goal-agent",
    model: runtime.model_ref,
    base_prompt: goalAgentPrompt(parsed.mode),
    tools: [],
    grants: ["read_workspace"],
    can_spawn: [],
    iteration_limit: budget.max_iterations,
    call_timeout_ms: budget.call_timeout_ms,
    retry: { max_retries: budget.max_retries, max_retry_after_ms: budget.call_timeout_ms },
    compaction: { enabled: false, prompt_mode: "none" },
  };
  return {
    execution_id: input.execution_id,
    session_id: input.session_id,
    agent_instance_id: input.agent_instance_id,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          mode: parsed.mode,
          ...(parsed.mode === "guided" ? { seed: parsed.seed } : {}),
          trajectory: input.trajectory.projection,
          trajectory_digest: input.trajectory.digest,
          trajectory_truncated: input.trajectory.truncated,
          workspace_read_available: input.trajectory.workspace_read_available,
        }),
      },
    ],
    servers: [],
    providers: runtime.providers,
    profiles: [profile],
    entry: "goal-agent",
    shared_prompt: "",
    budget: {
      on_exceed: "stop",
      total_token_limit: budget.max_net_tokens,
      timeout_ms: budget.timeout_ms,
    },
    output_schema: goalFormulationOutputSchema,
    elicit_wait_ms: 0,
  };
}

/** Normalize model-owned criterion text and assign deterministic host-owned identifiers. */
export function formulationCriteria(
  result: Extract<GoalFormulationResult, { status: "ready" }>,
): GoalCriterion[] {
  return result.criteria.map((criterion, index) => ({
    id: `criterion-${String(index + 1).padStart(2, "0")}`,
    description: criterion.description.trim().replace(/\s+/gu, " "),
    kind: criterion.kind,
  }));
}
