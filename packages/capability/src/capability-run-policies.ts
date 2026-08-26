import { z } from "zod";

/** Planning modes a trusted plugin may request for one of its own skill runs. */
export const capabilitySkillPlansModeSchema = z.enum(["off", "on", "review"]);

/** Run policy contributed by a plugin for the skills it packages. */
export const capabilityRunPoliciesSchema = z
  .object({
    plans: z
      .object({
        skills: z.record(z.string().min(1), capabilitySkillPlansModeSchema),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CapabilityRunPolicies = z.infer<typeof capabilityRunPoliciesSchema>;
export type CapabilitySkillPlansMode = z.infer<typeof capabilitySkillPlansModeSchema>;
