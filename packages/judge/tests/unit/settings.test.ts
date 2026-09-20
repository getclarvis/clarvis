import { describe, expect, test } from "bun:test";
import type { CapabilityRequestView } from "@clarvis/capability";
import {
  effectReviewSchema,
  guardJudgeSchema,
  judgeRequestConfig,
  judgeSettingsSpec,
  JUDGE_DEFAULTS,
} from "../../src/settings.ts";

function view(value: unknown): CapabilityRequestView {
  return {
    request: {
      messages: [],
      servers: [],
      providers: [],
      profiles: [],
      entry: "solo",
      budget: { on_exceed: "stop" },
    },
    requestParam: (key) => (key === "guard_judge" ? value : undefined),
  };
}

describe("Judge settings ownership", () => {
  test("keeps defaults explicit without materializing request overrides", () => {
    expect(JUDGE_DEFAULTS).toEqual({ onUnsure: "deny" });
    expect(guardJudgeSchema.parse({})).toEqual({});
    expect(effectReviewSchema.parse({})).toEqual({});
    expect(judgeRequestConfig(view(undefined))).toBeUndefined();
    expect(judgeSettingsSpec.referencedModels!(view(undefined))).toEqual([]);
    expect(judgeSettingsSpec.referencedModels!(view({ guidance: "bounded context" }))).toEqual([]);
    expect(judgeRequestConfig(view({ model: "provider/model" }))).toEqual({
      model: "provider/model",
    });
    expect(judgeSettingsSpec.referencedModels!(view({ model: "provider/model" }))).toEqual([
      "provider/model",
    ]);
  });

  test("rejects the removed alias as an unknown key instead of translating it", () => {
    const result = guardJudgeSchema.safeParse({ prompt: "legacy" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    expect(() => judgeRequestConfig(view({ prompt: "legacy" }))).toThrow();
  });

  test.each([
    { guidance: "" },
    { guidance: "x".repeat(32_769) },
    { model: "" },
    { timeout_ms: 0 },
    { timeout_ms: 2_147_483_648 },
    { timeout_ms: 1.5 },
    { max_retries: -1 },
    { max_retries: 0.5 },
    { on_unsure: "allow" },
    { rollout: "local" },
    { grants: [] },
  ])("rejects invalid request override %j", (value) => {
    expect(guardJudgeSchema.safeParse(value).success).toBe(false);
  });

  test.each(["shadow", "local"])("preserves rollout %s only on operator settings", (rollout) => {
    expect(effectReviewSchema.parse({ rollout })).toEqual({ rollout });
    expect(guardJudgeSchema.safeParse({ rollout }).success).toBe(false);
  });

  test("normalizes the withdrawn ci_retry stage instead of rejecting the whole document", () => {
    expect(effectReviewSchema.parse({ rollout: "ci_retry" })).toEqual({ rollout: "local" });
    expect(effectReviewSchema.parse({ rollout: "ci_retry", max_retries: 0 })).toEqual({
      rollout: "local",
      max_retries: 0,
    });
    expect(effectReviewSchema.safeParse({ rollout: "canary" }).success).toBe(false);
  });

  test("preserves strict settings limits and operator-only registration", () => {
    for (const value of [
      { model: "" },
      { model: "x".repeat(257) },
      { max_retries: -1 },
      { timeout_ms: 0 },
      { rollout: "unknown" },
      { guidance: "not a settings field" },
    ])
      expect(effectReviewSchema.safeParse(value).success).toBe(false);
    expect(
      guardJudgeSchema.parse({
        guidance: "x".repeat(32_768),
        timeout_ms: 180_000,
        max_retries: 3,
        on_unsure: "ask",
      }),
    ).toMatchObject({ timeout_ms: 180_000, max_retries: 3 });
    expect(judgeSettingsSpec.key).toBe("effect_review");
    expect(judgeSettingsSpec.pluginContributable).toBe(false);
    expect(judgeSettingsSpec.pluginForbiddenReason).toContain("operator");
    expect(judgeSettingsSpec.merge).toBe("lastWins");
    expect(Object.keys(judgeSettingsSpec.requestParams!)).toEqual(["guard_judge"]);
  });
});
