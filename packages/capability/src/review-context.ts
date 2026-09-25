import type { PortKey } from "./services.ts";

/** Host-attested semantic definition shared with Goal completion review. */
export interface OperatorReviewContext {
  kind: "goal" | "plan";
  content: string;
}

/** Current semantic definitions with an identity that changes when their content changes. */
export interface OperatorReviewContextSnapshot {
  revision: string;
  contexts: readonly OperatorReviewContext[];
}

export interface OperatorReviewContextProvider {
  snapshot(): OperatorReviewContextSnapshot;
}

/** Late-bound Plan context available to Goal completion review. */
export const PLANS_REVIEW_CONTEXT_PORT: PortKey<OperatorReviewContextProvider> = {
  id: "plans.review_context",
};
