import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { ProviderConfig } from "../../src/adapters/settings.ts";
import type { ProvidersViewContext } from "../../src/views/config/providers/context.ts";
import type { CatalogPickerSpec } from "../../src/views/config/CatalogPicker.tsx";
import { createProviderListLevel } from "../../src/views/config/providers/list-level.tsx";
import {
  createProviderDetailLevel,
  PROVIDER_DETAIL_FIELDS,
  PROVIDER_ISSUE_DETAIL_FIELD,
} from "../../src/views/config/providers/detail-level.tsx";
import {
  createProviderModelLevel,
  MODEL_FIELDS,
} from "../../src/views/config/providers/model-level.tsx";

function contextWith(providers: ProviderConfig[]): ProvidersViewContext {
  const [providerList] = createSignal(providers);
  const [sel, setSel] = createSignal(0);
  const [drill, setDrill] = createSignal(0);
  const [detailRow, setDetailRow] = createSignal(0);
  const [modelRow, setModelRow] = createSignal(0);
  const [modelId, setModelId] = createSignal("");
  const [, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const ctrl = Object.assign({} as ProvidersViewContext["ctrl"], {
    defaultWindow: 128000,
    validation: () => ({ ok: true as const }),
    defaultModel: () => undefined,
    fillModelFromCatalog: () => undefined,
    catalogModelFor: () => undefined,
  });
  return {
    host: {} as ProvidersViewContext["host"],
    catalog: null,
    notify: () => {},
    editor: {} as ProvidersViewContext["editor"],
    maps: {} as ProvidersViewContext["maps"],
    bootstrap: false,
    manualBootstrapProvider: () => false,
    setManualBootstrapProvider: () => {},
    providers: providerList,
    current: () => providerList()[drill()],
    sel,
    setSel,
    drill,
    setDrill,
    detailRow,
    modelRow,
    setModelRow,
    setDetailRow,
    modelId,
    setModelId,
    setPicker,
    startEdit: () => {},
    enterKey: () => {},
    manualModelEntry: () => {},
    finishBootstrap: () => {},
    openModelPicker: () => {},
    modelRemovalBlocked: () => false,
    openMap: () => {},
    mapCell: () => "0 entries",
    ctrl,
  } satisfies ProvidersViewContext;
}

describe("provider screen contracts", () => {
  test("L0 counts only provider rows; default_model lives in /model", () => {
    const empty = createProviderListLevel(contextWith([]));
    expect(empty.spec().nav?.count()).toBe(0);
    const populated = createProviderListLevel(
      contextWith([
        { name: "anthropic", kind: "anthropic" },
        { name: "openai", kind: "openai" },
      ]),
    );
    expect(populated.spec().nav?.count()).toBe(2);
  });

  test("every issue field the jump knows maps onto a real row, and only reachable ones", () => {
    // The jump used to carry its own {name:0, kind:1, base_url:2, api_key_env:3}
    // table: `kind` is a row validateProviders never issues, and the four
    // duplicated the head of PROVIDER_DETAIL_FIELDS with nothing pinning them
    // together.
    for (const [field, label] of Object.entries(PROVIDER_ISSUE_DETAIL_FIELD)) {
      expect({ field, row: PROVIDER_DETAIL_FIELDS.indexOf(label) >= 0 }).toEqual({
        field,
        row: true,
      });
    }
    expect(Object.keys(PROVIDER_ISSUE_DETAIL_FIELD).sort()).toEqual([
      "api_key_env",
      "base_url",
      "name",
    ]);
    expect(PROVIDER_ISSUE_DETAIL_FIELD.kind).toBeUndefined();
  });

  test("L1 keeps credential/map rows before the provider's model rows", () => {
    expect(PROVIDER_DETAIL_FIELDS).toEqual([
      "name",
      "kind",
      "base_url",
      "env var",
      "API key",
      "source",
      "headers",
      "body",
    ]);
    const level = createProviderDetailLevel(
      contextWith([
        {
          name: "anthropic",
          kind: "anthropic",
          models: { first: { context_window_tokens: 1 }, second: { context_window_tokens: 2 } },
        },
      ]),
    );
    expect(level.spec().nav?.count()).toBe(PROVIDER_DETAIL_FIELDS.length + 2);
  });

  test("L2 keeps limits, prompt cache, and request maps in their navigation order", () => {
    expect(MODEL_FIELDS).toEqual([
      "context_window_tokens",
      "max_output_tokens",
      "prompt_cache",
      "headers",
      "body",
    ]);
    createRoot((dispose) => {
      const changes: string[] = [];
      const ctx = contextWith([
        {
          name: "openrouter",
          kind: "openai-compatible",
          models: { model: { context_window_tokens: 128000 } },
        },
      ]);
      ctx.setModelId("model");
      ctx.ctrl.fillModelFromCatalog = () => ({
        modelId: "model",
        context_window_tokens: 200000,
        max_output_tokens: 8192,
        capabilities: ["tool_calling"],
        cost: { input: 1, output: 1, cache_read: 0.1, cache_write: 1 },
      });
      ctx.ctrl.catalogModelFor = ctx.ctrl.fillModelFromCatalog;
      ctx.ctrl.setModelField = (_index, _id, field) => changes.push(field);
      ctx.ctrl.setModelCapabilities = () => changes.push("capabilities");
      ctx.ctrl.setModelPromptCache = () => changes.push("prompt_cache");
      const level = createProviderModelLevel(ctx);
      expect(level.spec().nav?.count()).toBe(MODEL_FIELDS.length);
      const fill = level.spec().verbs?.find((verb) => verb.key === "f");
      expect(fill?.when?.()).toBe(true);
      fill?.run();
      expect(changes).toEqual([
        "context_window_tokens",
        "max_output_tokens",
        "capabilities",
        "prompt_cache",
      ]);
      dispose();
    });
  });
});
