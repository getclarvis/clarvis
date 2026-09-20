import { z } from "zod";
import type { CapabilityRequestView, CapabilitySettingsSpec } from "@clarvis/capability";

/** Operational defaults shared by the isolated reviewer and host configuration resolution. */
export const JUDGE_DEFAULTS = Object.freeze({
  onUnsure: "deny" as const,
});

/**
 * Rollout stages for the transactional configuration reviewer.
 *
 * @remarks `ci_retry` named the command classifier's reservation of a failed-only rerun. That
 *   classifier is withdrawn, so the spelling is no longer a stage; a settings document written
 *   before the withdrawal still parses, and its value normalizes to the conservative `local`
 *   ceiling rather than invalidating the document — a rejected document is discarded whole, which
 *   would silently drop every unrelated setting in the same file. Any other unknown value is still
 *   rejected.
 */
const rolloutSchema = z
  .enum(["shadow", "local", "ci_retry"])
  .transform((value): "shadow" | "local" => (value === "ci_retry" ? "local" : value));

/** Strict operator settings. Workspace scope may only lower limits under host policy. */
export const effectReviewSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    timeout_ms: z.number().int().positive().max(2_147_483_647).optional(),
    max_retries: z.number().int().nonnegative().optional(),
    on_unsure: z.enum(["ask", "deny"]).optional(),
    rollout: rolloutSchema.optional(),
  })
  .strict();

/** Caller text is bounded guidance, never a replacement for host review policy. */
export const guardJudgeSchema = z
  .object({
    guidance: z.string().min(1).max(32_768).optional(),
    model: z.string().min(1).optional(),
    on_unsure: z.enum(["ask", "deny"]).optional(),
    timeout_ms: z.number().int().positive().max(2_147_483_647).optional(),
    max_retries: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Shared reviewer operational settings, including the host-enforced rollout ceiling. */
export type EffectReviewConfig = z.infer<typeof effectReviewSchema>;
/** Per-request reviewer model, operational limits and untrusted guidance. */
export type GuardJudgeConfig = z.infer<typeof guardJudgeSchema>;

/** Read only the parameter this package owns through the generic request view. */
export function judgeRequestConfig(view: CapabilityRequestView): GuardJudgeConfig | undefined {
  const value = view.requestParam("guard_judge");
  return value === undefined ? undefined : guardJudgeSchema.parse(value);
}

/** One registration owns both shared settings and per-request reviewer overrides. */
export const judgeSettingsSpec: CapabilitySettingsSpec = {
  key: "effect_review",
  schema: effectReviewSchema,
  merge: "lastWins",
  pluginContributable: false,
  pluginForbiddenReason: "effect_review belongs to the operator, not a plugin",
  requestParams: {
    guard_judge: guardJudgeSchema
      .optional()
      .describe(
        "Reviewer configuration with optional bounded guidance, model, timeout and retries. " +
          "The host supplies authenticated evidence and immutable policy. Auto ignores on_unsure " +
          "'ask' and refuses uncertainty to the calling agent.",
      ),
  },
  referencedModels(view) {
    const model = judgeRequestConfig(view)?.model;
    return model === undefined ? [] : [model];
  },
};
