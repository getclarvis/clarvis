import {
  cacheModeOf as kernelCacheModeOf,
  derivePromptCacheMode as kernelDerivePromptCacheMode,
  parseModelRef as kernelParseModelRef,
} from "@clarvis/kernel/config";
import type { ProviderKind } from "./settings.ts";

/** Pricing fields needed to classify a model's prompt-cache behavior. */
export interface CachePricing {
  cache_read?: number;
  cache_write?: number;
}

/** Split a configured `provider/model` reference through Code's model-policy boundary. */
export function parseModelRef(modelRef: string): { provider: string; modelId: string } {
  return kernelParseModelRef(modelRef);
}

/** Classify catalog pricing without exposing Kernel configuration helpers to presentation. */
export function cacheModeOf(cost: CachePricing | undefined): "explicit" | "implicit" | "unknown" {
  return kernelCacheModeOf(cost);
}

/** Resolve the prompt-cache mode Code should persist for a provider/model pair. */
export function derivePromptCacheMode(
  cost: CachePricing | undefined,
  kind: ProviderKind,
): "explicit" | "implicit" | undefined {
  return kernelDerivePromptCacheMode(cost, kind);
}
