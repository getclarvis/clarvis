import type { CapabilitySettingsSpec } from "@clarvis/capability";
import type { z } from "zod";
import { z as schema } from "zod";
import { goalLimitsSchema } from "./schemas.ts";

export const goalAgentSettingsSchema = schema
  .object({
    model: schema
      .string()
      .regex(/^[a-z0-9_-]+\/[a-zA-Z0-9_./:-]+$/u)
      .optional(),
    formulation: schema
      .object({
        max_net_tokens: schema
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .optional(),
        timeout_ms: schema.number().int().positive().max(120_000).optional(),
        max_iterations: schema.number().int().positive().max(8).optional(),
        call_timeout_ms: schema.number().int().positive().max(60_000).optional(),
        max_retries: schema.number().int().nonnegative().max(1).optional(),
      })
      .strict()
      .optional(),
    verification: schema
      .object({
        stage_token_limit: schema.number().int().positive().max(32_000).optional(),
        attempt_token_limit: schema.number().int().positive().max(16_000).optional(),
        max_attempts: schema.number().int().positive().max(3).optional(),
        iteration_limit: schema.number().int().positive().max(6).optional(),
        timeout_ms: schema.number().int().positive().max(90_000).optional(),
        call_timeout_ms: schema.number().int().positive().max(60_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Creation defaults only: an omitted token cap inherits the finite entry budget.
 * Persisted goals are unaffected by later configuration changes. The lightweight
 * entry imports schemas without loading the capability, tools or control runtime.
 */
export const goalsSettingsSchema = goalLimitsSchema
  .partial({ max_net_tokens: true })
  .extend({ agent: goalAgentSettingsSchema.optional() });

/** Authored settings input; schema defaults supply omitted continuation and progress limits. */
export type GoalsSettingsBlock = z.input<typeof goalsSettingsSchema>;

/** Whole-block scope precedence, with no plugin contribution or model-callable run parameter. */
export const goalsSettingsSpec: CapabilitySettingsSpec = {
  key: "goals",
  schema: goalsSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
