import type { OperatorReviewContext, OperatorReviewContextProvider } from "@clarvis/capability";

export type ReviewerContextPayload = Array<{
  kind: OperatorReviewContext["kind"];
  definition: Record<string, unknown>;
}>;

export interface ReviewerContextSnapshot {
  live_revision?: string;
  payload?: ReviewerContextPayload;
}

/** Decode host-shaped semantic definitions into one ordered model payload. */
export function reviewerContextSnapshot(
  persisted: OperatorReviewContext | undefined,
  live: OperatorReviewContextProvider | undefined,
): ReviewerContextSnapshot {
  const liveSnapshot = live?.snapshot();
  const contexts = [
    ...(persisted === undefined ? [] : [persisted]),
    ...(liveSnapshot?.contexts ?? []),
  ];
  const seen = new Set<OperatorReviewContext["kind"]>();
  const payload: ReviewerContextPayload = [];
  for (const context of contexts) {
    if (seen.has(context.kind)) continue;
    try {
      const definition: unknown = JSON.parse(context.content);
      if (typeof definition !== "object" || definition === null || Array.isArray(definition))
        continue;
      payload.push({ kind: context.kind, definition: definition as Record<string, unknown> });
      seen.add(context.kind);
    } catch {
      continue;
    }
  }
  return {
    ...(liveSnapshot === undefined ? {} : { live_revision: liveSnapshot.revision }),
    ...(payload.length === 0 ? {} : { payload }),
  };
}

/** Reject a reviewer result if its late-bound Plans definition changed in flight. */
export function reviewerContextIsCurrent(
  live: OperatorReviewContextProvider | undefined,
  revision: string | undefined,
): boolean {
  return live?.snapshot().revision === revision;
}
