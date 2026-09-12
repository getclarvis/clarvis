import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

/** Closed shared-reviewer settings; not owned by tools or configurable through plugins. */
export const effectReviewSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    timeout_ms: z.number().int().positive().max(120000).optional(),
    max_retries: z.number().int().min(0).max(2).optional(),
    on_unsure: z.enum(["ask", "deny"]).optional(),
    rollout: z.enum(["shadow", "local", "ci_retry"]).optional(),
  })
  .strict();

/** Host resolution enforces scope restrictions before any reviewer is constructed. */
export const effectReviewSettingsSpec: CapabilitySettingsSpec = {
  key: "effect_review",
  schema: effectReviewSchema,
  merge: "lastWins",
  pluginContributable: false,
  pluginForbiddenReason: "effect_review belongs to the operator, not a plugin",
};

/** Reject plugin attempts explicitly instead of treating an authority setting as an inert extra key. */
export const EFFECT_REVIEW_PLUGIN_FIELDS = {
  effect_review: z.undefined({ error: effectReviewSettingsSpec.pluginForbiddenReason }).optional(),
};
