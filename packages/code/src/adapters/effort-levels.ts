import { parseModelRef } from "@clarvis/kernel/config";
import type { ModelsCatalog } from "./models-catalog.ts";
import { resolveCatalogModel } from "./models-catalog.ts";
import type { ProviderConfig } from "./settings.ts";

/** The reasoning-effort levels selectable for a run, lowest to highest. */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Map provider vocabulary into Clarvis's settings vocabulary and drop unknown values. */
export function normalizeReasoningEfforts(values: readonly string[]): EffortLevel[] {
  const normalized = values.map((value) => (value === "none" ? "off" : value));
  return EFFORT_LEVELS.filter((level) => normalized.includes(level));
}

/** Published effort levels for a configured model; undefined means the catalog has no answer. */
export function supportedReasoningEfforts(
  catalog: ModelsCatalog | null,
  providers: ProviderConfig[],
  modelRef: string | undefined,
): EffortLevel[] | undefined {
  if (!modelRef) return undefined;
  const { provider: providerName, modelId } = parseModelRef(modelRef);
  const configured = providers.find((provider) => provider.name === providerName);
  const configuredEfforts = configured?.models?.[modelId]?.reasoning_efforts;
  if (configuredEfforts !== undefined) return normalizeReasoningEfforts(configuredEfforts);
  if (configured?.kind === "openai-codex" || configured?.kind === "xai-grok") return undefined;
  if (!catalog) return undefined;
  const model = resolveCatalogModel(catalog, providers, modelRef);
  if (!model) return undefined;
  if (model.reasoning_efforts !== undefined) {
    return normalizeReasoningEfforts(model.reasoning_efforts);
  }
  if (model.capabilities !== undefined && !model.capabilities.includes("reasoning")) return [];
  return undefined;
}

/** A balanced valid default for a newly selected model, preferring quality on equal distance. */
export function recommendedReasoningEffort(
  levels: readonly EffortLevel[] | undefined,
): EffortLevel | undefined {
  const usable = levels?.filter((level) => level !== "off") ?? [];
  if (usable.length === 0) return undefined;
  const medium = EFFORT_LEVELS.indexOf("medium");
  return [...usable].sort((a, b) => {
    const ai = EFFORT_LEVELS.indexOf(a);
    const bi = EFFORT_LEVELS.indexOf(b);
    return Math.abs(ai - medium) - Math.abs(bi - medium) || bi - ai;
  })[0];
}
