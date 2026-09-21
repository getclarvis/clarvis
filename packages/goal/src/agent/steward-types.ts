import type { AgentProfile, PerAgentUsage } from "@clarvis/capability";
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
  })
  .strict()
  .refine((value) => (value.scope === "criterion") === (value.criterion_id !== undefined));

/** One fixed wire schema preserves the tool catalog across definition and completion review. */
export const goalStewardResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("definition"),
      verdict: z.enum(["accept_definition", "revise_definition"]),
      summary: text,
      guidance: text.optional(),
    })
    .strict()
    .refine((value) => (value.verdict === "revise_definition") === (value.guidance !== undefined), {
      message: "A definition revision requires specific guidance",
    }),
  z
    .object({
      decision: z.literal("completion"),
      verdict: z.enum(["achieved", "needs_work", "needs_evidence"]),
      summary: text,
      assessments: z.array(assessment).min(2).max(34),
      next_step: text.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const verdicts = value.assessments.map((item) => item.verdict);
      const expected = verdicts.includes("unsatisfied")
        ? "needs_work"
        : verdicts.includes("inconclusive")
          ? "needs_evidence"
          : "achieved";
      const keys = value.assessments.map((item) => `${item.scope}:${item.criterion_id ?? ""}`);
      if (
        value.verdict !== expected ||
        !unique(keys) ||
        value.assessments.filter((item) => item.scope === "definition").length !== 1 ||
        value.assessments.filter((item) => item.scope === "objective").length !== 1 ||
        (value.verdict !== "achieved" && value.next_step === undefined)
      )
        ctx.addIssue({ code: "custom", message: "Inconsistent or incomplete Steward assessments" });
    }),
]);

export type GoalStewardResult = z.infer<typeof goalStewardResultSchema>;

/**
 * Why a completed evaluation could not be settled.
 *
 * @remarks `usage_unknown` is not a transport fault: the evaluation answered —
 *   possibly with a valid `achieved` — but its consumption could not be
 *   determined, and a Goal cannot be concluded on an unaccountable review. It
 *   was reported as `transport` until the two were separated, which named the
 *   wrong cause in the operator's record.
 */
export type GoalStewardInterruptionCause =
  "timeout" | "transport" | "invalid_output" | "cancelled" | "usage_unknown";

/**
 * Operator-facing text for each technical interruption cause.
 *
 * @remarks Fixed engine prose rather than a provider string, so a transcript can
 *   name the cause without publishing a payload, a reasoning trace or a raw
 *   provider error — and without the reason code standing in for an explanation
 *   it does not carry: `goal_steward_failed` covers a timeout, a transport fault
 *   and an unaccountable review alike, and only this text tells them apart.
 *
 *   Shared by both entry capabilities — the guided creation turn and the bound
 *   work run — which otherwise stated the same failure two different ways, and
 *   left the turn that reported the original defect naming no cause at all.
 */
export const STEWARD_INTERRUPTION_TEXT: Record<GoalStewardInterruptionCause, string> = {
  timeout: "the Steward review did not finish in time",
  transport: "the Steward review failed in transit",
  cancelled: "the Steward review was cancelled",
  invalid_output: "the Steward review returned an unusable result",
  usage_unknown: "the Steward review's token consumption could not be determined",
};

/**
 * The terminal code and operator-facing reason one interrupted review reports.
 *
 * @param decision - an interrupted completion decision.
 * @returns the domain code the run ends with, and the cause in fixed prose.
 * @remarks One function rather than the same three lines in each entry
 *   capability: a guided creation turn and the bound work run end a Goal for the
 *   same reason, and they reported it differently — the work run naming the cause
 *   and the creation turn naming none. An unrecognized reason maps to
 *   `goal_steward_inconclusive` rather than passing through, so the code set
 *   stays the two the Goal contract declares.
 */
export function stewardInterruptionOutcome(
  decision: Extract<GoalStewardCompletionDecision, { kind: "interrupted" }>,
): { code: "goal_steward_failed" | "goal_steward_inconclusive"; reason: string } {
  return {
    code:
      decision.reason === "goal_steward_failed"
        ? "goal_steward_failed"
        : "goal_steward_inconclusive",
    reason: STEWARD_INTERRUPTION_TEXT[decision.cause],
  };
}

export type GoalStewardRuntime = GoalAgentRuntime & {
  reasoning_effort?: AgentProfile["reasoning_effort"];
};
export type GoalStewardFinalizeAttempt =
  { mode: "text"; text: string } | { mode: "submit"; text?: string; submitted_value?: unknown };
export type GoalStewardCompletionDecision =
  | { kind: "achieved"; review_id: string }
  | { kind: "needs_work"; review_id: string; next_step: string }
  | { kind: "needs_evidence"; review_id: string; next_step: string }
  | {
      kind: "interrupted";
      review_id: string;
      reason: string;
      cause: GoalStewardInterruptionCause;
    };
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

/** Host-owned qualitative targets constrain completion assessments; evidence IDs are optional. */
export function validateGoalStewardResult(
  input: unknown,
  mode: "definition" | "completion",
  qualitativeIds: readonly string[],
): GoalStewardResult {
  const result = goalStewardResultSchema.parse(input);
  if (
    (mode === "definition" && result.decision !== "definition") ||
    (mode === "completion" && result.decision !== "completion")
  )
    throw new Error("Goal Steward returned a decision for another evaluation mode");
  if (result.decision === "completion") {
    const ids = result.assessments
      .filter((item) => item.scope === "criterion")
      .map((item) => item.criterion_id!);
    if (ids.length !== qualitativeIds.length || ids.some((id) => !qualitativeIds.includes(id)))
      throw new Error("Goal Steward returned unknown targets");
  }
  return result;
}
