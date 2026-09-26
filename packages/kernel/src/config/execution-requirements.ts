import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

/** Operator-owned native boundaries that approvals cannot discard. */
export const executionRequirementsSchema = z
  .object({
    read_only_paths: z.array(z.string()).optional(),
    deny_read_paths: z.array(z.string()).optional(),
    judge_required: z.boolean().optional(),
    strict_review: z.boolean().optional(),
  })
  .strict();

export type ExecutionRequirements = z.input<typeof executionRequirementsSchema>;

export const executionRequirementsSpec: CapabilitySettingsSpec = {
  key: "execution_requirements",
  schema: executionRequirementsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
