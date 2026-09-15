import { z } from "zod";
import { goalAssessmentSchema, goalEvidenceRefSchema, goalProgressSchema } from "./schemas.ts";

const summary = goalProgressSchema.shape.summary;
const evidenceIds = z.array(goalEvidenceRefSchema.shape.id).max(8).default([]);

/** Model evidence arguments name opaque host-issued references, never execution or owner scope. */
export const goalModelAssessmentSchema = goalAssessmentSchema
  .omit({ evidence: true })
  .extend({ evidence_ids: evidenceIds })
  .strict();

export const goalProgressInputSchema = z.object({ summary, evidence_ids: evidenceIds }).strict();
export const goalCheckpointInputSchema = goalProgressInputSchema.extend({ next_step: summary });
export const goalCandidateInputSchema = z
  .object({ summary, assessments: z.array(goalModelAssessmentSchema).min(1).max(32) })
  .strict();

/** User-only controls and caller-selected identities are absent from the model vocabulary. */
export const goalModelUpdateSchema = z.discriminatedUnion("action", [
  goalProgressInputSchema.extend({ action: z.literal("progress") }),
  goalCheckpointInputSchema.extend({ action: z.literal("checkpoint") }),
  goalCandidateInputSchema.extend({ action: z.literal("candidate") }),
  z.object({ action: z.literal("blocked"), reason: summary }).strict(),
]);

/**
 * The same action union validates dispatch and produces the advertised tool catalog.
 * Nested alternatives retain a portable object root without advertising unrelated fields as
 * optional siblings that a structured-output provider may require the model to populate.
 */
export const goalModelToolInputSchema = z
  .object({ update: z.union(goalModelUpdateSchema.options) })
  .strict();

export type GoalProgressInput = z.infer<typeof goalProgressInputSchema>;
export type GoalCheckpointInput = z.infer<typeof goalCheckpointInputSchema>;
export type GoalCandidateInput = z.infer<typeof goalCandidateInputSchema>;
