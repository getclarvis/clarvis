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
  ).toEqual({ timeout_ms: 120000, max_retries: 2, on_unsure: "deny" });
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
    max_retries: 0,
    on_unsure: "deny",
  });
});

test("workspace retries can only lower the effective runtime or operator limit", () => {
  expect(resolveEffectReviewSettings({}, {}, 45000, 4)).not.toHaveProperty("max_retries");
  expect(resolveEffectReviewSettings({}, { max_retries: 9 }, 45000, 4)?.max_retries).toBe(4);
  expect(resolveEffectReviewSettings({}, { max_retries: 0 }, 45000, 4)?.max_retries).toBe(0);
  expect(
    resolveEffectReviewSettings({ max_retries: 1 }, { max_retries: 9 }, 45000, 4)?.max_retries,
  ).toBe(1);
});

test("workspace timeout is capped by the effective runtime default without materializing an override", () => {
  expect(resolveEffectReviewSettings({}, {}, 45000)).not.toHaveProperty("timeout_ms");
  expect(resolveEffectReviewSettings({}, { timeout_ms: 120000 }, 45000)?.timeout_ms).toBe(45000);
  expect(
    resolveEffectReviewSettings({ timeout_ms: 90000 }, { timeout_ms: 120000 }, 45000)?.timeout_ms,
  ).toBe(90000);
});
