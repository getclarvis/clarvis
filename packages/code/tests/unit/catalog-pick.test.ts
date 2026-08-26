import { expect, test } from "bun:test";
import {
  catalogReady,
  configuredModelCapabilities,
  filterRows,
  knownToLackReasoning,
  MANUAL_ROW,
  modelRows,
  providerRows,
  recommendedProviderRows,
  type CatalogRow,
} from "../../src/views/config/catalog-pick.ts";
import type {
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "../../src/adapters/models-catalog.ts";

function row(id: string): CatalogRow {
  return { id, label: id, haystack: id };
}

test("filterRows returns every match — no top-40 cap", () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(`prov-${i}`));
  expect(filterRows(rows, "prov", false)).toHaveLength(60);
  expect(filterRows(rows, "", false)).toHaveLength(60);
});

test("filterRows score-orders matches and keeps original order on an empty term", () => {
  const rows = [row("bxa"), row("xab")];
  expect(filterRows(rows, "x", false)[0]!.id).toBe("xab");
  expect(filterRows(rows, "", false).map((r) => r.id)).toEqual(["bxa", "xab"]);
});

test("filterRows appends the manual row last, present even at zero matches", () => {
  const rows = [row("alpha")];
  expect(filterRows(rows, "zzz", true)).toEqual([MANUAL_ROW]);
  const all = filterRows(rows, "", true);
  expect(all[all.length - 1]).toBe(MANUAL_ROW);
  expect(filterRows(rows, "zzz", false)).toHaveLength(0);
});

test("providerRows carries kind, model count and the needs-base_url flag", () => {
  const providers = [
    {
      id: "a",
      name: "A",
      kind: "openai-compatible",
      needsBaseUrl: true,
      models: [{ modelId: "m1" }, { modelId: "m2" }],
    },
    { id: "b", name: "B", kind: "anthropic", needsBaseUrl: false, models: [] },
  ] as unknown as CatalogProvider[];
  const rows = providerRows(providers);
  expect(rows[0]!.detail).toBe("openai-compatible · 2 models · custom endpoint required");
  expect(rows[1]!.detail).toBe("anthropic · 0 models");
  expect(rows[0]!.haystack).toContain("openai-compatible");
});

test("recommendedProviderRows puts familiar providers first and limits first-run choice", () => {
  const providers = [
    { id: "302ai", name: "302.AI", kind: "openai-compatible", models: [] },
    { id: "anthropic", name: "Anthropic", kind: "anthropic", models: [] },
    { id: "openrouter", name: "OpenRouter", kind: "openai-compatible", models: [] },
    { id: "openai", name: "OpenAI", kind: "openai", models: [] },
  ] as unknown as CatalogProvider[];
  const rows = recommendedProviderRows(providers, 6);
  expect(rows.map((row) => row.id)).toEqual(["openrouter", "openai", "anthropic"]);
  expect(rows.every((row) => row.detail?.startsWith("recommended · "))).toBe(true);
});

test("modelRows keeps the raw label and exposes ctx/out + capabilities as fixed-width columns", () => {
  const models: CatalogModel[] = [
    {
      modelId: "m1",
      context_window_tokens: 200000,
      max_output_tokens: 64000,
      capabilities: ["tool_calling", "vision"],
    },
    { modelId: "m2" },
  ];
  const rows = modelRows(models, new Set(["m2"]));
  expect(rows[0]!.label).toBe("m1");
  expect(rows[0]!.columns).toEqual([
    { text: "200k/64k", width: 10 },
    { text: "T   V  ", width: 7 },
  ]);
  expect(rows[0]!.added).toBe(false);
  expect(rows[1]!.label).toBe("m2");
  expect(rows[1]!.columns).toEqual([
    { text: "—/—", width: 10 },
    { text: "—", width: 7 },
  ]);
  expect(rows[1]!.added).toBe(true);
});

test("modelRows renders the cache slot from the price shape, not from a capability tag", () => {
  const models: CatalogModel[] = [
    // Charging to create an entry means creation is an act you perform.
    { modelId: "explicit", cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } },
    // A read price with free creation: the provider does it for you.
    { modelId: "implicit", cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
    // Free creation is implicit, not explicit — a presence check gets this wrong.
    { modelId: "free-write", cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } },
    { modelId: "silent", cost: { input: 1, output: 2 } },
  ];
  const rows = modelRows(models, new Set());
  const slot = (i: number): string => rows[i]!.columns![1]!.text.at(-1)!;
  expect(slot(0)).toBe("C");
  expect(slot(1)).toBe("c");
  expect(slot(2)).toBe("c");
  expect(rows[3]!.columns![1]!.text).toBe("—");
});

test("modelRows keeps the cache slot for a model with no capability tags at all", () => {
  // The em-dash short-circuit is decided from every slot, not from `capabilities`
  // alone: a catalog entry can price a cache while listing no capabilities, and
  // an early return on `!caps?.length` would silently drop its glyph.
  const rows = modelRows(
    [{ modelId: "m", cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } }],
    new Set(),
  );
  expect(rows[0]!.columns![1]!.text).toBe("      C");
});

test("modelRows formats million-scale ctx/out in M instead of overflowing k", () => {
  const models: CatalogModel[] = [
    { modelId: "grok-4.3", context_window_tokens: 1_000_000, max_output_tokens: 1_000_000 },
  ];
  const rows = modelRows(models, new Set());
  expect(rows[0]!.columns![0]).toEqual({ text: "1M/1M", width: 10 });
});

test("catalogReady: null or empty catalog is not ready", () => {
  expect(catalogReady(null)).toBe(false);
  expect(catalogReady({ providers: () => [] } as unknown as ModelsCatalog)).toBe(false);
  expect(catalogReady({ providers: () => [{ id: "x" }] } as unknown as ModelsCatalog)).toBe(true);
});

test("configuredModelCapabilities looks up capabilities by full provider/modelId reference", () => {
  const providers = [
    {
      name: "openrouter",
      models: {
        "glm-5.2": { capabilities: ["tool_calling", "reasoning"] },
        "qwen-max": {},
      },
    },
  ];
  expect(configuredModelCapabilities(providers, "openrouter/glm-5.2")).toEqual([
    "tool_calling",
    "reasoning",
  ]);
  expect(configuredModelCapabilities(providers, "openrouter/qwen-max")).toBeUndefined();
  expect(configuredModelCapabilities(providers, "openrouter/unknown-model")).toBeUndefined();
  expect(configuredModelCapabilities(providers, "ghost/glm-5.2")).toBeUndefined();
  expect(configuredModelCapabilities(providers, undefined)).toBeUndefined();
  expect(configuredModelCapabilities(providers, "not-a-provider-slash-model")).toBeUndefined();
});

test("knownToLackReasoning only fires when capabilities are known and omit 'reasoning'", () => {
  expect(knownToLackReasoning(["tool_calling", "vision"])).toBe(true);
  expect(knownToLackReasoning(["tool_calling", "reasoning"])).toBe(false);
  expect(knownToLackReasoning(undefined)).toBe(false);
  expect(knownToLackReasoning([])).toBe(true);
});
