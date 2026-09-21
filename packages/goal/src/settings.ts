import type { CapabilitySettingsSpec } from "@clarvis/capability";
import type { z } from "zod";
import { z as schema } from "zod";
import { goalLimitsSchema } from "./schemas.ts";

export const goalAgentSettingsSchema = schema
  .object({
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
    steward: schema
      .object({
        model: schema
          .string()
          .regex(/^[a-z0-9_-]+\/[a-zA-Z0-9_./:-]+$/u)
          .optional(),
        max_net_tokens: schema
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .optional(),
        timeout_ms: schema.number().int().positive().max(3_600_000).optional(),
        max_iterations: schema.number().int().positive().max(8).optional(),
        call_timeout_ms: schema.number().int().positive().max(60_000).optional(),
        max_retries: schema.number().int().nonnegative().max(1).optional(),
        max_reviews_per_work_run: schema.number().int().min(1).max(32).optional(),
        max_completion_reviews_per_attempt: schema.number().int().min(1).max(2).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Creation defaults only: an omitted token cap inherits the finite entry budget.
 * Persisted goals are unaffected by later configuration changes. The lightweight
 * entry imports schemas without loading the capability, tools or control runtime.
 *
 * `max_no_progress_stages` deliberately carries no default here: the domain default
 * lives in `goalLimitsSchema`, and leaving this copy absent is what lets
 * {@link resolveGoalsSettings} still see a document that only carries the legacy
 * spelling. A document that fails validation is discarded whole by the settings
 * store, which is why the legacy key is accepted by the schema and normalized in
 * memory rather than rejected.
 */
export const goalsSettingsSchema = goalLimitsSchema.partial({ max_net_tokens: true }).extend({
  max_no_progress_stages: goalLimitsSchema.shape.max_no_progress_stages.removeDefault().optional(),
  /** Renamed from `max_no_progress_checkpoints`; accepted, then normalized in memory. */
  max_no_progress_checkpoints: schema.number().int().min(1).max(32).optional(),
  agent: goalAgentSettingsSchema.optional(),
});

/** Authored settings input; schema defaults supply omitted continuation and progress limits. */
export type GoalsSettingsBlock = z.input<typeof goalsSettingsSchema>;

/** Parsed settings block in the current vocabulary. */
export type GoalsSettings = z.output<typeof goalsSettingsSchema>;

/**
 * Normalize an accepted settings document to the current field vocabulary.
 *
 * @param block - the merged `goals` settings block, or nothing when the scope has none.
 * @returns the parsed block with the renamed limit under its current name.
 * @remarks Only the spelling moves: a value that was never a stage limit is still
 *   rejected by the schema. Nothing is written back, so a read leaves the operator's
 *   document untouched, and the normalized value is what creation copies into a new
 *   Goal's persisted limits.
 */
export function resolveGoalsSettings(block: unknown): GoalsSettings {
  const parsed = goalsSettingsSchema.parse(block ?? {});
  const { max_no_progress_checkpoints: legacy, ...rest } = parsed;
  return {
    ...rest,
    ...(rest.max_no_progress_stages === undefined && legacy !== undefined
      ? { max_no_progress_stages: legacy }
      : {}),
  };
}

/** Whole-block scope precedence, with no plugin contribution or model-callable run parameter. */
export const goalsSettingsSpec: CapabilitySettingsSpec = {
  key: "goals",
  schema: goalsSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
