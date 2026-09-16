import type { OperatorReviewContext, OperatorReviewContextProvider } from "@clarvis/capability";

export type ReviewerContextPayload = Array<{
  kind: OperatorReviewContext["kind"];
  definition: Record<string, unknown>;
}>;

/** Decode host-shaped semantic definitions into one ordered model payload. */
export function reviewerContextPayload(
  persisted: OperatorReviewContext | undefined,
  live: OperatorReviewContextProvider | undefined,
): ReviewerContextPayload | undefined {
  const contexts = [...(persisted === undefined ? [] : [persisted]), ...(live?.snapshot() ?? [])];
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
  return payload.length === 0 ? undefined : payload;
}
