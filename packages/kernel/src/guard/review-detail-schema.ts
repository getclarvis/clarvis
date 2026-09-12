import { z } from "zod";

const word = z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Closed receipt vocabulary at every transport boundary; no evidence or model prose is accepted. */
export const effectReviewDetailShape = {
  analysis: z
    .object({
      reviewability: z.enum(["static", "judgeable", "human_only"]),
      issues: z
        .array(
          z
            .object({
              segmentIndex: z.number().int().min(0).max(1023),
              kind: z.enum([
                "parameter_expansion",
                "command_substitution",
                "process_substitution",
                "dynamic_command",
                "dynamic_subcommand",
                "dynamic_path",
                "opaque_command",
                "opaque_path",
                "unbalanced_syntax",
                "tokenizer_gap",
              ]),
              impact: z.enum([
                "value",
                "executable",
                "subcommand",
                "path",
                "environment",
                "control_flow",
              ]),
            })
            .strict(),
        )
        .max(128),
    })
    .strict()
    .optional(),
  effect: z
    .object({
      id: word,
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
      attestation: z.enum(["complete", "partial", "none"]),
      target_digest: digest.optional(),
    })
    .strict()
    .optional(),
  authority: z
    .object({
      revision: z.number().int().nonnegative(),
      relation: z.enum(["direct", "bounded_prerequisite", "none"]),
      within_scope: z.boolean(),
    })
    .strict()
    .optional(),
  reviewer: z
    .object({
      status: z.enum(["failed", "invalid", "unsure"]),
      failure_kind: z
        .enum([
          "timeout",
          "auth",
          "quota",
          "rate_limit",
          "transport",
          "admission",
          "cancelled",
          "invalid_response",
          "unknown",
        ])
        .optional(),
      elapsed_ms: z.number().int().nonnegative().optional(),
      attempts: z.number().int().min(0).max(16).optional(),
    })
    .strict()
    .optional(),
};

/** Shared closed command detail validation for direct and hosted elicitation channels. */
export const elicitationCommandDetailSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    reason: z.string(),
    warning: z.string().optional(),
    ...effectReviewDetailShape,
  })
  .strict();
