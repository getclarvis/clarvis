import { expect, test } from "bun:test";
import type { LLMCallParams } from "@clarvis/capability";
import {
  boundEffectReviewCanaryProvider,
  EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS,
  runEffectReviewCanary,
} from "../canary/effect-review.ts";

test("real-provider canaries reject absent opt-in and incomplete provider coverage before constructing an SDK", async () => {
  const provider = {
    resolveRegistryKey: () => {
      throw new Error("credentials must not be read");
    },
  };
  await expect(runEffectReviewCanary({ optIn: false, provider, models: [] })).rejects.toThrow(
    "explicit opt-in",
  );
  await expect(runEffectReviewCanary({ optIn: true, provider, models: [] })).rejects.toThrow(
    "two distinct",
  );
  await expect(
    runEffectReviewCanary({
      optIn: true,
      provider,
      models: [
        { scheme: "openai-codex", model: "fixture" },
        { scheme: "openai-codex", model: "fixture" },
      ],
    }),
  ).rejects.toThrow("two distinct");
  await expect(
    runEffectReviewCanary({
      optIn: true,
      provider,
      trials: 4,
      models: [
        { scheme: "openai-codex", model: "fixture" },
        { scheme: "xai-grok", model: "fixture" },
      ],
    }),
  ).rejects.toThrow("1..3");
  await expect(
    runEffectReviewCanary({
      optIn: true,
      provider,
      externalCallLimit: 21,
      models: [
        { scheme: "openai-codex", model: "luna" },
        { scheme: "openai-codex", model: "terra" },
      ],
    }),
  ).rejects.toThrow("1..20");
});

test("real-provider canaries enforce one global physical-call ceiling", async () => {
  let physical = 0;
  const bounded = boundEffectReviewCanaryProvider({
    async call() {
      physical++;
      return {
        text: "fixture",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    },
  });
  const params = {} as LLMCallParams;
  for (let index = 0; index < EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS; index++)
    await bounded.provider.call(params);
  await expect(bounded.provider.call(params)).rejects.toThrow("budget exhausted");
  expect(physical).toBe(EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS);
  expect(bounded.used()).toBe(EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS);
});

test("canary executes native private Judge runs when subscription authorization fails", async () => {
  let resolutions = 0;
  const result = await runEffectReviewCanary({
    optIn: true,
    provider: {
      resolveRegistryKey: () => undefined,
      resolveSubscription: async () => {
        resolutions++;
        throw new Error("Fixture subscription unavailable");
      },
    },
    models: [
      { scheme: "openai-codex", model: "fixture" },
      { scheme: "xai-grok", model: "fixture" },
    ],
  });
  expect(result.execution).toBe("native-judge-capability");
  expect(result.external_calls).toBe(6);
  expect(result.external_call_limit).toBe(EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS);
  expect(result.records).toHaveLength(6);
  expect(result.records.map((record) => record.model)).toEqual([
    "fixture",
    "fixture",
    "fixture",
    "fixture",
    "fixture",
    "fixture",
  ]);
  expect(resolutions).toBeGreaterThan(0);
  for (const record of result.records) {
    expect(record.private_runs).toBe(1);
    expect(record.decision).toBe("unsure");
    expect(record.provider_calls).toEqual([]);
  }
  expect(JSON.stringify(result)).not.toContain("Fixture subscription unavailable");
});
