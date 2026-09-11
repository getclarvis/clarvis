import { z } from "zod";

/** Bounded stage handoff, independent of any final-result schema. */
export const checkpointMetadataSchema = z
  .object({
    summary: z.string().trim().min(1).max(4096),
    next_step: z.string().trim().min(1).max(4096),
  })
  .strict();

/** What changed in this stage and what a host may continue after settlement. */
export type CheckpointMetadata = z.infer<typeof checkpointMetadataSchema>;

/** A stage boundary is separate from the execution's success or failure status. */
export type FinalizationDisposition = "final" | "checkpoint";

/**
 * The accepted ending carried by agent, run and durable execution results.
 *
 * @remarks Absence means the ordinary final-result path. Checkpoint metadata
 * never satisfies a final output schema and does not authorize another run.
 */
export type RunFinalization =
  | { disposition?: "final"; checkpoint?: never }
  | { disposition: "checkpoint"; checkpoint: CheckpointMetadata };
