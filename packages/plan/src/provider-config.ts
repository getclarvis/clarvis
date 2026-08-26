import { z } from "zod";
import { capabilityExecutableDeclarationSchema } from "@clarvis/capability";

/** Operator-authored selection of the plan persistence implementation. */
export const planProviderConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown") }).strict(),
  capabilityExecutableDeclarationSchema.extend({ kind: z.literal("executable") }),
  z.object({ kind: z.literal("plugin"), plugin: z.string().trim().min(1) }).strict(),
]);

/** A validated plan-provider selection. An absent selection means Markdown. */
export type PlanProviderConfig = z.infer<typeof planProviderConfigSchema>;
