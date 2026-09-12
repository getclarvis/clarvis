import { z } from "zod";
import { createGuardEffectRegistry } from "./effects/registry.ts";

const registry = createGuardEffectRegistry();
const effect = z.string().refine((id) => registry.get(id) !== undefined);
const count = z.number().int().nonnegative();
const consumer = z.enum(["command_guard", "configure_clarvis"]);
const stage = z.enum(["compile", "decide"]);
const common = {
  consumer,
  stage,
  revision: count.optional(),
  elapsed_ms: count,
  attempts: count.max(16),
};

/** Guest telemetry admits only bounded scalar facts; raw prose and unknown keys are rejected. */
export const effectReviewAuditSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("effect_review.reviewer.started"),
      consumer,
      stage,
      model: z.string().regex(/^[A-Za-z0-9_./:-]{1,128}$/),
      provider: z.string().regex(/^[a-z0-9_-]{1,64}$/),
      revision: count,
      effect_id: effect,
    })
    .strict(),
  z
    .object({
      event: z.literal("effect_review.reviewer.completed"),
      ...common,
      decision: z.enum(["allow", "deny", "unsure"]).optional(),
      relation: z.enum(["direct", "bounded_prerequisite", "none"]).optional(),
      input_tokens: count.optional(),
      output_tokens: count.optional(),
      cache_hit: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("effect_review.reviewer.failed"),
      ...common,
      input_tokens: count.optional(),
      output_tokens: count.optional(),
      failure_kind: z.enum([
        "timeout",
        "auth",
        "quota",
        "rate_limit",
        "transport",
        "admission",
        "cancelled",
        "invalid_response",
        "unknown",
      ]),
    })
    .strict(),
  z
    .object({
      event: z.literal("operator_authority.recompiled"),
      revision: count,
      objective_count: count.max(8),
      grant_count: count.max(32),
      exclusion_count: count.max(32),
    })
    .strict(),
  z
    .object({
      event: z.literal("effect_review.effect.attested"),
      consumer,
      effect_id: effect,
      class: z.enum([
        "read",
        "local_mutation",
        "external_observation",
        "external_mutation",
        "destructive",
        "credential",
        "authority_change",
        "unknown",
      ]),
      inference: z.enum(["bounded", "explicit", "human_only"]),
      attestation: z.enum(["complete", "partial", "none"]),
      target_digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
