import type { AgentProfile, PerAgentUsage } from "@clarvis/capability";
import { z } from "zod";
import type { GoalAgentBudget, GoalAgentRuntime } from "./types.ts";
import type { GoalUsage } from "../schemas.ts";

/** Host-selected review operation; the model only supplies its verdict. */
export type GoalStewardMode = "definition" | "completion";

const verdict = z.enum([
  "achieved",
  "needs_work",
  "needs_evidence",
  "accept_definition",
  "revise_definition",
]);

const fallbackMessage: Record<z.infer<typeof verdict>, string> = {
  achieved: "The reported result meets the goal.",
  needs_work:
    "Continue working toward the goal and address any remaining requirements before presenting the result again.",
  needs_evidence:
    "Clarify how the reported result satisfies the goal and provide the missing supporting information.",
  accept_definition: "The definition matches the operator's request.",
  revise_definition:
    "Revise the definition to faithfully reflect the operator's requested outcome and scope.",
};

/**
 * The verdict alone determines the review; commentary cannot invalidate it.
 *
 * @remarks Unknown fields are discarded. Missing, blank or non-text commentary
 *   uses host guidance; long text is bounded for the persisted review.
 */
export const goalStewardResultSchema = z
  .object({ verdict, message: z.unknown().optional() })
  .transform(({ verdict, message }) => ({
    verdict,
    message:
      (typeof message === "string" ? message.trim().slice(0, 4096) : "") ||
      fallbackMessage[verdict],
  }));

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
  mode: GoalStewardMode;
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

/** Accept only a verdict belonging to the host-selected operation. */
export function validateGoalStewardResult(
  input: unknown,
  mode: GoalStewardMode,
): GoalStewardResult {
  const result = goalStewardResultSchema.parse(input);
  const definition =
    result.verdict === "accept_definition" || result.verdict === "revise_definition";
  if ((mode === "definition") !== definition)
    throw new Error("Goal Steward returned a verdict for another evaluation mode");
  return result;
}
