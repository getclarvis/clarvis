import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

export const judgeSettingsSchema = z
  .object({
    model: z.string().min(3).optional(),
    guidance: z.string().max(4000).optional(),
    timeout_ms: z.number().int().min(1000).max(300000).optional(),
    max_attempts: z.number().int().min(1).max(3).optional(),
    fallback: z.enum(["manual_on_context_overflow", "disabled"]).optional(),
  })
  .strict();

export type JudgeSettings = z.input<typeof judgeSettingsSchema>;

export const judgeSettingsSpec: CapabilitySettingsSpec = {
  key: "judge",
  schema: judgeSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
