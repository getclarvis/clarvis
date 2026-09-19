import {
  canonicalJudgeJson,
  JudgeArchitectureError,
  type JudgeCoordinator,
  type JudgeFailureKind,
  type JudgeJson,
} from "@clarvis/judge";
import type { GuardJudgeConfig } from "@clarvis/judge/settings";
import type { OperatorAuthorityReader } from "@clarvis/capability";
import type { ElicitRequest } from "@clarvis/loop";
import { callFacts } from "./command-facts.ts";
export interface JudgeElicitAnswer {
  allowed: boolean;
  answerer: "judge";
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

function refuse(review?: JudgeElicitAnswer["review"]): JudgeElicitAnswer {
  return { allowed: false, answerer: "judge", ...(review === undefined ? {} : { review }) };
}

/**
 * Call-local Auto review over the shared semantic port.
 *
 * Unsure, stale, failed and evidence-less outcomes refuse to the calling agent.
 * Concurrent identical cases share one in-flight promise; settled answers are not
 * reused as human consent. `on_unsure` is ignored.
 */
export function createCommandReview(
  deps: {
    judge(): JudgeCoordinator | undefined;
    authority?: OperatorAuthorityReader;
    reviewContext?: ReviewerContextSource;
    signal?: AbortSignal;
  },
  config: GuardJudgeConfig,
): JudgeElicit {
  const pending = new Map<string, Promise<JudgeElicitAnswer>>();
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
      if (deps.signal?.aborted) return refuse();
      if (state?.status !== "active" || state.evidence.length === 0)
        return refuse({ reviewer_decision: "unsure" });
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
      if (result.kind === "failed") {
        return refuse({ failure_kind: result.failureKind, reviewer_decision: "failed" });
      }
      if (!isCurrent() || result.kind === "stale") return refuse({ reviewer_decision: "unsure" });
      if (result.receipt.decision !== "unsure")
        return {
          allowed: result.receipt.decision === "allow",
          answerer: "judge",
          review: { reviewer_decision: result.receipt.decision },
        };
      return refuse({ reviewer_decision: "unsure" });
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
