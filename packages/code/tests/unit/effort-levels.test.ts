import { expect, test } from "bun:test";
import type { ModelCatalog } from "@clarvis/protocol";
import {
  normalizeReasoningEfforts,
  recommendedReasoningEffort,
  supportedReasoningEfforts,
} from "../../src/adapters/effort-levels.ts";
import { createModelsCatalog } from "../../src/adapters/models-catalog.ts";
import type { ProviderConfig } from "../../src/adapters/settings.ts";

const catalog = createModelsCatalog({
  source: "bundle",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      kind: "openai",
      needs_base_url: false,
      models: [{ id: "gpt-5", reasoning_efforts: ["minimal", "low", "medium", "high"] }],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "anthropic",
      needs_base_url: false,
      models: [{ id: "claude-sonnet", reasoning_efforts: ["low", "medium", "high", "max"] }],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      kind: "openai-compatible",
      base_url: "https://openrouter.ai/api/v1",
      needs_base_url: false,
      models: [
        {
          id: "openai/gpt-5.6-luna",
          reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      ],
    },
  ],
} satisfies ModelCatalog);

const providers: ProviderConfig[] = [
  { name: "openai", kind: "openai" },
  { name: "anthropic", kind: "anthropic" },
  {
    name: "router-custom-name",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1/",
  },
];

const subscriptionProviders: ProviderConfig[] = [
  {
    name: "chatgpt",
    kind: "openai-codex",
    models: {
      "gpt-codex": {
        context_window_tokens: 200_000,
        reasoning_efforts: ["low", "medium", "high"],
      },
    },
  },
];

const legacySubscriptionProviders: ProviderConfig[] = [
  {
    name: "chatgpt",
    kind: "openai-codex",
    models: { "gpt-codex": { context_window_tokens: 200_000 } },
  },
];

test("resolves model-specific efforts for native and OpenAI-compatible providers", () => {
  expect(supportedReasoningEfforts(catalog, providers, "openai/gpt-5")).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  expect(supportedReasoningEfforts(catalog, providers, "anthropic/claude-sonnet")).toEqual([
    "low",
    "medium",
    "high",
    "max",
  ]);
  expect(
    supportedReasoningEfforts(catalog, providers, "router-custom-name/openai/gpt-5.6-luna"),
  ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
});

test("normalizes provider none to Clarvis off and ignores unknown future values", () => {
  expect(normalizeReasoningEfforts(["none", "low", "turbo", "max"])).toEqual(["off", "low", "max"]);
});

test("resolves persisted entitled efforts without the public catalog", () => {
  expect(supportedReasoningEfforts(null, subscriptionProviders, "chatgpt/gpt-codex")).toEqual([
    "low",
    "medium",
    "high",
  ]);
});

test("does not borrow public-catalog efforts for a legacy subscription model", () => {
  expect(supportedReasoningEfforts(catalog, legacySubscriptionProviders, "chatgpt/gpt-5")).toBe(
    undefined,
  );
});

test("picks medium when possible and the closest quality-biased supported level otherwise", () => {
  expect(recommendedReasoningEffort(["low", "medium", "high"])).toBe("medium");
  expect(recommendedReasoningEffort(["low", "high"])).toBe("high");
  expect(recommendedReasoningEffort(["off"])).toBeUndefined();
  expect(recommendedReasoningEffort(undefined)).toBeUndefined();
});
