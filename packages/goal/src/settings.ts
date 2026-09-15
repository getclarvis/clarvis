import type { CapabilitySettingsSpec } from "@clarvis/capability";
import type { z } from "zod";
import { goalLimitsSchema } from "./schemas.ts";

/**
 * Creation defaults only: an omitted token cap inherits the finite entry budget.
 * Persisted goals are unaffected by later configuration changes. The lightweight
 * entry imports schemas without loading the capability, tools or control runtime.
 */
export const goalsSettingsSchema = goalLimitsSchema.partial({ max_net_tokens: true });

/** Authored settings input; schema defaults supply omitted continuation and progress limits. */
export type GoalsSettingsBlock = z.input<typeof goalsSettingsSchema>;

/** Whole-block scope precedence, with no plugin contribution or model-callable run parameter. */
export const goalsSettingsSpec: CapabilitySettingsSpec = {
  key: "goals",
  schema: goalsSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
