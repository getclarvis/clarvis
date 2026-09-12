import { expect, test } from "bun:test";
import { runEffectReviewCanary } from "../canary/effect-review.ts";

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
    "requires one",
  );
  await expect(
    runEffectReviewCanary({
      optIn: true,
      provider,
      trials: 6,
      models: [
        { scheme: "openai-codex", model: "fixture" },
        { scheme: "xai-grok", model: "fixture" },
      ],
    }),
  ).rejects.toThrow("1..5");
});
