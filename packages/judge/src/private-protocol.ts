import { z } from "zod";
import { authorityEnvelopeSchema } from "./authority-schema.ts";

const revision = z.number().int().nonnegative();
const token = z.string().min(1).max(256);
const verdict = {
  decision: z.enum(["allow", "deny", "unsure"]),
  reason: z.string().max(512).optional(),
};

/** The sole private tool accepts one closed action at the current stage. */
const compileAuthorityStepSchema = z
  .object({ action: z.literal("compile_authority"), candidate: authorityEnvelopeSchema })
  .strict();
const decideEffectsStepSchema = z
  .object({
    action: z.literal("decide_effects"),
    ...verdict,
    revision,
    transition_token: token,
    grant_ids: z.array(token).max(32),
    relation: z.enum(["direct", "bounded_prerequisite", "none"]),
  })
  .strict();
export const decideCommandStepSchema = z
  .object({ action: z.literal("decide_command"), ...verdict })
  .strict();

export const judgeStepSchema = z.discriminatedUnion("action", [
  compileAuthorityStepSchema,
  decideEffectsStepSchema,
  decideCommandStepSchema,
]);

/** Validated host transaction output; it grants no authority outside the host ledger. */
export const compiledAuthorityTransitionSchema = z
  .object({
    envelope: authorityEnvelopeSchema,
    revision,
    transition_token: token,
  })
  .strict()
  .refine((value) => value.envelope.revision === value.revision);

export type JudgeStep = z.infer<typeof judgeStepSchema>;
export type CompiledAuthorityTransition = z.infer<typeof compiledAuthorityTransitionSchema>;
export type JudgeTerminalReceipt = Exclude<JudgeStep, { action: "compile_authority" }>;
