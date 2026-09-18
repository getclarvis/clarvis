import type { OperatorInstructions, PerAgentUsage } from "@clarvis/capability";
import { z } from "zod";
import type { GoalAgentBudget, GoalAgentRuntime } from "./types.ts";
import type { GoalUsage } from "../schemas.ts";

const text = z.string().trim().min(1).max(4096);
const unique = (items: string[]): boolean => new Set(items).size === items.length;
const assessment = z
  .object({
    scope: z.enum(["definition", "objective", "criterion"]),
    criterion_id: z.string().min(1).max(256).optional(),
    verdict: z.enum(["satisfied", "unsatisfied", "inconclusive"]),
    rationale: text,
    evidence_ids: z.array(z.string().min(1).max(256)).max(32).refine(unique),
    inspected_paths: z.array(text).max(16).refine(unique),
  })
  .strict()
  .refine((value) => (value.scope === "criterion") === (value.criterion_id !== undefined));

/** One fixed wire schema preserves the tool catalog across every evaluation mode. */
export const goalStewardResultSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("aligned"), summary: text }).strict(),
  z.object({ decision: z.literal("steer"), summary: text, guidance: text }).strict(),
  z.object({ decision: z.literal("new_run"), summary: text, next_step: text }).strict(),
  z
    .object({
      decision: z.literal("completion"),
      verdict: z.enum(["achieved", "not_achieved", "inconclusive"]),
      summary: text,
      assessments: z.array(assessment).min(2).max(34),
      next_step: text.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const verdicts = value.assessments.map((item) => item.verdict);
      const expected = verdicts.includes("unsatisfied")
        ? "not_achieved"
        : verdicts.includes("inconclusive")
          ? "inconclusive"
          : "achieved";
      const keys = value.assessments.map((item) => `${item.scope}:${item.criterion_id ?? ""}`);
      if (
        value.verdict !== expected ||
        !unique(keys) ||
        value.assessments.filter((item) => item.scope === "definition").length !== 1 ||
        value.assessments.filter((item) => item.scope === "objective").length !== 1 ||
        (value.verdict === "not_achieved" && value.next_step === undefined)
      )
        ctx.addIssue({ code: "custom", message: "Inconsistent or incomplete Steward assessments" });
    }),
]);

export type GoalStewardResult = z.infer<typeof goalStewardResultSchema>;
export interface GoalStewardRuntime extends GoalAgentRuntime {
  /** Host-captured operating context; never grants this reviewer additional permissions. */
  operator_instructions?: readonly Pick<OperatorInstructions, "scope" | "source" | "content">[];
}
export type GoalStewardFinalizeAttempt =
  { mode: "text"; text: string } | { mode: "submit"; text?: string; submitted_value?: unknown };
export type GoalStewardCompletionDecision =
  | { kind: "achieved"; review_id: string }
  | { kind: "not_achieved"; review_id: string; next_step: string }
  | { kind: "inconclusive"; review_id: string; reason: string };
export type GoalStewardIntervention =
  { kind: "steer"; guidance: string } | { kind: "new_run"; next_step: string };

export interface GoalStewardRunInput {
  execution_id: string;
  session_id: string;
  continue_from?: string;
  projection: string;
  signal?: AbortSignal;
  budget: GoalAgentBudget;
  prompt_cache_ttl: "5m" | "1h";
}

export interface GoalStewardRunResult {
  execution_id: string;
  result: GoalStewardResult;
  usage: GoalUsage;
  elapsed_ms: number;
  accounting?: PerAgentUsage[];
}

/** Host-owned catalogs constrain all semantic target and evidence references. */
export function validateGoalStewardResult(
  input: unknown,
  mode: "observation" | "completion",
  qualitativeIds: readonly string[],
  evidenceIds: readonly string[],
): GoalStewardResult {
  const result = goalStewardResultSchema.parse(input);
  if ((result.decision === "completion") !== (mode === "completion"))
    throw new Error("Goal Steward returned a decision for another evaluation mode");
  if (result.decision === "completion") {
    const ids = result.assessments
      .filter((item) => item.scope === "criterion")
      .map((item) => item.criterion_id!);
    if (
      ids.length !== qualitativeIds.length ||
      ids.some((id) => !qualitativeIds.includes(id)) ||
      result.assessments.some((item) => item.evidence_ids.some((id) => !evidenceIds.includes(id)))
    )
      throw new Error("Goal Steward returned unknown targets or evidence");
  }
  return result;
}
