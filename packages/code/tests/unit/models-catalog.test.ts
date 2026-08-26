import { expect, test } from "bun:test";
import type { ModelCatalog } from "@clarvis/protocol";
import { createModelsCatalog, resolveModelPrice } from "../../src/adapters/models-catalog.ts";
import type { ProviderConfig } from "../../src/adapters/settings.ts";

const CATALOG: ModelCatalog = {
  source: "bundle",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "anthropic",
      api_key_env: "ANTHROPIC_API_KEY",
      needs_base_url: false,
      models: [
        {
          id: "claude-x",
          name: "Claude X",
          context_window: 200000,
          max_output: 64000,
          capabilities: ["tool_calling", "vision"],
          reasoning_efforts: ["low", "medium", "high", "max"],
          cost: { input: 3, output: 15, cache_read: 0.3 },
        },
      ],
    },
    {
      id: "togetherai",
      name: "Together",
      kind: "openai-compatible",
      base_url: "https://api.together.xyz/v1",
      needs_base_url: false,
      models: [{ id: "glm-5", cost: { input: 0.5, output: 0.5 } }],
    },
  ],
};

test("createModelsCatalog maps protocol DTOs to the UI shape (modelId, context_window_tokens)", () => {
  const cat = createModelsCatalog(CATALOG);
  expect(cat.source).toBe("bundle");
  const anthropic = cat.provider("anthropic")!;
  expect(anthropic.needsBaseUrl).toBe(false);
  const model = anthropic.models[0]!;
  expect(model.modelId).toBe("claude-x");
  expect(model.context_window_tokens).toBe(200000);
  expect(model.max_output_tokens).toBe(64000);
  expect(model.capabilities).toEqual(["tool_calling", "vision"]);
  expect(model.reasoning_efforts).toEqual(["low", "medium", "high", "max"]);
});

test("seed builds a ProviderConfig (safe name, kind, base_url, api_key_env)", () => {
  const cat = createModelsCatalog(CATALOG);
  expect(cat.seed("anthropic", new Set())).toEqual({
    name: "anthropic",
    kind: "anthropic",
    api_key_env: "ANTHROPIC_API_KEY",
  });
  expect(cat.seed("togetherai", new Set())).toEqual({
    name: "togetherai",
    kind: "openai-compatible",
    base_url: "https://api.together.xyz/v1",
  });
  expect(cat.seed("anthropic", new Set(["anthropic"]))?.name).toBe("anthropic-2");
  expect(cat.seed("nope", new Set())).toBeUndefined();
});

test("resolveModelPrice: exact match, then a same-kind fill", () => {
  const cat = createModelsCatalog(CATALOG);
  const providers: ProviderConfig[] = [
    { name: "anthropic", kind: "anthropic" },
    { name: "together", kind: "openai-compatible", base_url: "https://x/v1" },
  ];
  expect(resolveModelPrice(cat, providers, "anthropic/claude-x")).toEqual({
    input: 3,
    output: 15,
    cache_read: 0.3,
  });
  expect(resolveModelPrice(cat, providers, "together/glm-5")).toEqual({ input: 0.5, output: 0.5 });
  expect(resolveModelPrice(cat, providers, "ghost/x")).toBeUndefined();
});
