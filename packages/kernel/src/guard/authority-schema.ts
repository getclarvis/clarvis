import { z } from "zod";

const id = z.string().min(1).max(256);
const ids = z.array(id).min(1).max(32);
const constraints = z
  .record(id, z.union([z.string().max(256), z.number().int().nonnegative(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 16);

/** Closed persisted and model-output shape; semantic coverage is validated separately by the host. */
export const authorityEnvelopeSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    objectives: z
      .array(
        z
          .object({ id, summary: z.string().max(512), target_digests: ids, evidence_ids: ids })
          .strict(),
      )
      .max(8),
    grants: z
      .array(
        z
          .object({
            id,
            effect_id: id,
            relation: z.enum(["direct", "bounded_prerequisite"]),
            target_digests: ids,
            constraints,
            evidence_ids: ids,
          })
          .strict(),
      )
      .max(32),
    exclusions: z
      .array(
        z
          .object({
            effect_id: id.optional(),
            class: z
              .enum([
                "read",
                "local_mutation",
                "external_observation",
                "external_mutation",
                "destructive",
                "credential",
                "authority_change",
                "unknown",
              ])
              .optional(),
            target_digests: ids.optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
