/**
 * ModelCatalogService — model and pricing catalog served by the kernel.
 *
 * Replaces the bundled/cached `models-dev.json` a UI used to own. The UI needs no
 * local catalog snapshot and no upstream fetch of its own.
 */

import type { SubscriptionScheme } from "./provider-auth.ts";

/** Per-token pricing for a catalog model (currency units as reported by the source). */
export interface ModelCost {
  /** Price per input (prompt) token. */
  input: number;
  /** Price per output (completion) token. */
  output: number;
  /** Price per token read from the prompt cache, when the provider distinguishes it. */
  cache_read?: number;
  /** Price per token written to the prompt cache, when the provider distinguishes it. */
  cache_write?: number;
}

/** One model entry in a provider's catalog. */
export interface CatalogModel {
  /** Provider-native model id used when selecting the model. */
  id: string;
  /** Human-readable display name, when the source supplies one. */
  name?: string;
  /** Maximum context length in tokens. */
  context_window?: number;
  /** Maximum output length in tokens. */
  max_output?: number;
  /** Source-reported capability tags (e.g. tool use, vision). */
  capabilities?: string[];
  /** Provider-native reasoning-effort values accepted by this model. */
  reasoning_efforts?: string[];
  cost?: ModelCost;
}

/** One upstream provider and its models. */
export interface CatalogProvider {
  /** Stable provider id (e.g. `anthropic`, `openai`). */
  id: string;
  name: string;
  /** Provider family/protocol (e.g. an OpenAI-compatible endpoint kind). */
  kind: string;
  /** API base URL, when the provider has (or requires) a configurable endpoint. */
  base_url?: string;
  /** Name of the environment variable / secret holding this provider's API key. */
  api_key_env?: string;
  /**
   * `true` when this is an OpenAI-compatible endpoint with no `base_url` yet —
   * the UI must prompt for one.
   */
  needs_base_url: boolean;
  models: CatalogModel[];
}

/** Full model catalog snapshot returned by the kernel. */
export interface ModelCatalog {
  providers: CatalogProvider[];
  /** Whether the catalog came from the refreshed cache or the bundled snapshot. */
  source: "cache" | "bundle";
}

/** Fetch and refresh the model/pricing catalog. */
export interface ModelCatalogService {
  /** Return the current catalog (cache or bundle). */
  get(): Promise<ModelCatalog>;

  /**
   * Refresh from the upstream source (kernel fetches and caches).
   *
   * @returns The refreshed catalog.
   */
  refresh(): Promise<ModelCatalog>;

  /** Return model metadata authorized for the currently connected subscription account. */
  getEntitled(scheme: SubscriptionScheme): Promise<CatalogProvider>;

  /** Refresh model metadata from the authenticated subscription surface. */
  refreshEntitled(scheme: SubscriptionScheme): Promise<CatalogProvider>;
}
