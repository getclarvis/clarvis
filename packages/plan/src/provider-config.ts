import { z } from "zod";

/** Operator-authored selection of the plan persistence implementation. */
export const planProviderConfigSchema = z.object({ kind: z.literal("markdown") }).strict();

/** A validated plan-provider selection. An absent selection means Markdown. */
export type PlanProviderConfig = z.infer<typeof planProviderConfigSchema>;
