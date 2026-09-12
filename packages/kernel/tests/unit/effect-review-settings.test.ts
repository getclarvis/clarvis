import { expect, test } from "bun:test";
import { resolveEffectReviewSettings } from "../../src/config/effect-review-settings.ts";

test("workspace settings cannot choose a reviewer, enable rollout or increase bounds", () => {
  expect(resolveEffectReviewSettings()).toBeUndefined();
  expect(
    resolveEffectReviewSettings(undefined, {
      model: "evil/model",
      rollout: "ci_retry",
      timeout_ms: 120000,
      max_retries: 2,
    }),
  ).toEqual({ timeout_ms: 20000, max_retries: 1, on_unsure: "ask" });
  expect(
    resolveEffectReviewSettings(
      {
        model: "operator/model",
        rollout: "local",
        timeout_ms: 1000,
        max_retries: 0,
        on_unsure: "deny",
      },
      {
        model: "evil/model",
        rollout: "ci_retry",
        timeout_ms: 500,
        max_retries: 2,
        on_unsure: "ask",
      },
    ),
  ).toEqual({
    model: "operator/model",
    rollout: "local",
    timeout_ms: 500,
    max_retries: 0,
    on_unsure: "deny",
  });
  expect(resolveEffectReviewSettings({}, { on_unsure: "deny", max_retries: 0 })).toEqual({
    timeout_ms: 20000,
    max_retries: 0,
    on_unsure: "deny",
  });
});
