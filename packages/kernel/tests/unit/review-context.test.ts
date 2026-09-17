import { expect, test } from "bun:test";
import type { OperatorReviewContextProvider } from "@clarvis/capability";
import {
  reviewerAuthoritySnapshot,
  reviewerContextIsCurrent,
  reviewerContextSnapshot,
} from "../../src/guard/review-context.ts";

test("review resolves Plans after activation and rejects replacement or removal in flight", () => {
  let provider: OperatorReviewContextProvider | undefined = undefined;
  const source = () => provider;
  expect(reviewerContextSnapshot(undefined, source)).toEqual({});
  provider = {
    snapshot: () => ({
      revision: "plan-1",
      contexts: [{ kind: "plan", content: '{"objective":"install dependencies"}' }],
    }),
  };
  const snapshot = reviewerContextSnapshot(undefined, source);
  expect(snapshot).toEqual({
    live_revision: "plan-1",
    payload: [{ kind: "plan", definition: { objective: "install dependencies" } }],
  });
  expect(reviewerContextIsCurrent(source, snapshot.live_revision)).toBe(true);
  provider = { snapshot: () => ({ revision: "plan-2", contexts: [] }) };
  expect(reviewerContextIsCurrent(source, snapshot.live_revision)).toBe(false);
  provider = undefined;
  expect(reviewerContextIsCurrent(source, snapshot.live_revision)).toBe(false);
});

test("a newly available Plans context invalidates a review begun without one", () => {
  let provider: OperatorReviewContextProvider | undefined = undefined;
  const source = () => provider;
  const snapshot = reviewerContextSnapshot(undefined, source);
  expect(reviewerContextIsCurrent(source, snapshot.live_revision)).toBe(true);
  provider = { snapshot: () => ({ revision: "plan-1", contexts: [] }) };
  expect(reviewerContextIsCurrent(source, snapshot.live_revision)).toBe(false);
});

test("authority projection omits identity and content published in dedicated prompt blocks", () => {
  expect(
    reviewerAuthoritySnapshot({
      version: 1,
      binding: {
        owner_key_name: "owner",
        session_id: "session",
        controller_epoch: "epoch",
      },
      status: "active",
      revision: 2,
      evidence: [{ id: "e1", source: "start", text: "ship", execution_id: "execution" }],
      review_context: { kind: "goal", content: '{"objective":"ship"}' },
      denied_effects: ["a".repeat(64)],
    }),
  ).toEqual({ version: 1, status: "active", revision: 2, denied_effects: ["a".repeat(64)] });
});
