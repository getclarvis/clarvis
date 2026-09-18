import {
  canonicalJudgeJson,
  JudgeArchitectureError,
  type JudgeCoordinator,
  type JudgeFailureKind,
  type JudgeJson,
} from "@clarvis/judge";
import type { GuardJudgeConfig } from "@clarvis/judge/settings";
import type { OperatorAuthorityReader } from "@clarvis/capability";
import type { ElicitRequest, GuardElicit } from "@clarvis/loop";
import { callFacts } from "./command-facts.ts";
export interface JudgeElicitAnswer {
  allowed: boolean;
  answerer: "judge" | "human";
  review?: {
    failure_kind?: JudgeFailureKind;
    reviewer_decision?: "allow" | "deny" | "unsure" | "failed";
  };
}

export type JudgeElicit = (req: ElicitRequest) => Promise<JudgeElicitAnswer>;
import {
  reviewerContextIsCurrent,
  reviewerContextSnapshot,
  reviewerAuthoritySnapshot,
  type ReviewerContextSource,
} from "./review-context.ts";

/** Host-owned fallback and in-flight human-answer deduplication around the shared semantic port. */
export function createCommandReview(
  deps: {
    judge(): JudgeCoordinator | undefined;
    authority?: OperatorAuthorityReader;
    reviewContext?: ReviewerContextSource;
    signal?: AbortSignal;
  },
  config: GuardJudgeConfig,
  human: GuardElicit | undefined,
): JudgeElicit {
  const pending = new Map<string, Promise<JudgeElicitAnswer>>();
  const fallback = async (req: ElicitRequest, note: string): Promise<JudgeElicitAnswer> => {
    if (deps.signal?.aborted || config.on_unsure !== "ask" || human === undefined)
      return { allowed: false, answerer: "judge" };
    const answer = await human({ ...req, reason: req.reason ? `${req.reason}\n\n${note}` : note });
    return {
      allowed:
        !deps.signal?.aborted &&
        (answer === true || (typeof answer === "object" && answer.allowed === true)),
      answerer: "human",
    };
  };
  return (req) => {
    const port = deps.judge();
    if (port === undefined) throw new JudgeArchitectureError();
    const state = deps.authority?.snapshot();
    const context = reviewerContextSnapshot(state?.review_context, deps.reviewContext);
    const currentCase = JSON.parse(callFacts(req, undefined)) as JudgeJson;
    const snapshot = JSON.parse(
      JSON.stringify({
        authority: reviewerAuthoritySnapshot(state),
        operator_evidence: state?.evidence ?? [],
        operator_instructions: state?.instructions ?? [],
        review_context: context.payload,
        review_context_revision: context.live_revision,
        guidance: config.guidance,
      }),
    ) as JudgeJson;
    const key = canonicalJudgeJson([snapshot, currentCase]);
    const existing = pending.get(key);
    if (existing !== undefined) return existing;
    const operation = (async (): Promise<JudgeElicitAnswer> => {
      if (deps.signal?.aborted) return { allowed: false, answerer: "judge" };
      if (state?.status !== "active" || state.evidence.length === 0)
        return fallback(req, "Automatic review has no authenticated operator evidence.");
      const isCurrent = () => {
        const current = deps.authority?.snapshot();
        return (
          !deps.signal?.aborted &&
          current?.status === "active" &&
          current.revision === state.revision &&
          reviewerContextIsCurrent(deps.reviewContext, context.live_revision)
        );
      };
      const result = await port.reviewCommand(
        { currentCase, consumer: "command_guard" },
        { snapshot: () => snapshot, isCurrent, validateReceipt: () => isCurrent() },
      );
      if (result.kind === "failed" && result.failureKind === "cancelled")
        return { allowed: false, answerer: "judge" };
      if (!isCurrent() || result.kind === "stale")
        return fallback(
          req,
          "Operator authority or Plan context changed during automatic command review.",
        );
      if (result.kind === "failed") {
        if (config.on_unsure !== "ask" || human === undefined)
          return {
            allowed: false,
            answerer: "judge",
            review: { failure_kind: result.failureKind, reviewer_decision: "failed" },
          };
        const answer = await fallback(
          req,
          "The automatic command reviewer did not return a valid decision.",
        );
        return {
          ...answer,
          review: { failure_kind: result.failureKind, reviewer_decision: "failed" },
        };
      }
      if (result.receipt.decision !== "unsure")
        return {
          allowed: result.receipt.decision === "allow",
          answerer: "judge",
          review: { reviewer_decision: result.receipt.decision },
        };
      const answer = await fallback(
        req,
        "The automatic command reviewer was unsure" +
          (result.receipt.reason === undefined ? "." : ` (${result.receipt.reason}).`),
      );
      return { ...answer, review: { reviewer_decision: "unsure" } };
    })();
    pending.set(key, operation);
    void operation.then(
      () => {
        if (pending.get(key) === operation) pending.delete(key);
      },
      () => {
        if (pending.get(key) === operation) pending.delete(key);
      },
    );
    return operation;
  };
}
