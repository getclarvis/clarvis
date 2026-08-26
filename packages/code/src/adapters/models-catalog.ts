import { parseModelRef } from "@clarvis/kernel/config";
import type {
  CatalogModel as ProtoCatalogModel,
  CatalogProvider as ProtoCatalogProvider,
  ModelCatalog,
  ModelCost,
} from "@clarvis/protocol";
import type { ProviderConfig, ProviderKind } from "./settings.ts";

/** Every supported provider kind, in the order offered to the user. */
export const PROVIDER_KINDS: ProviderKind[] = [
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
  "openai-codex",
  "xai-grok",
];

/** A model's pricing, as carried by the kernel's model catalog. */
export type CatalogCost = ModelCost;

/** A model as presented by the UI's catalog lookups. */
export interface CatalogModel {
  modelId: string;
  name?: string;
  context_window_tokens?: number;
  max_output_tokens?: number;
  capabilities?: string[];
  reasoning_efforts?: string[];
  cost?: CatalogCost;
}

/** A provider as presented by the UI's catalog lookups, with its available models. */
export interface CatalogProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url?: string;
  api_key_env?: string;
  needsBaseUrl: boolean;
  models: CatalogModel[];
}

/** The UI's read/seed/fill interface over a loaded (kernel) model catalog. */
export interface ModelsCatalog {
  source: "cache" | "bundle";
  providers(): CatalogProvider[];
  provider(id: string): CatalogProvider | undefined;
  models(providerId: string): CatalogModel[];
  seed(providerId: string, taken: ReadonlySet<string>): ProviderConfig | undefined;
  fill(kind: ProviderKind, modelId: string): CatalogModel | undefined;
}

function toModel(m: ProtoCatalogModel): CatalogModel {
  return {
    modelId: m.id,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.context_window !== undefined ? { context_window_tokens: m.context_window } : {}),
    ...(m.max_output !== undefined ? { max_output_tokens: m.max_output } : {}),
    ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
    ...(m.reasoning_efforts !== undefined ? { reasoning_efforts: m.reasoning_efforts } : {}),
    ...(m.cost !== undefined ? { cost: m.cost } : {}),
  };
}

/** Resolve model metadata for a configured provider, preserving endpoint identity when possible. */
export function resolveCatalogModel(
  catalog: ModelsCatalog,
  providers: ProviderConfig[],
  modelRef: string,
): CatalogModel | undefined {
  const { provider: providerName, modelId } = parseModelRef(modelRef);
  const configured = providers.find((provider) => provider.name === providerName);
  if (!configured) return undefined;

  const exact = catalog
    .provider(configured.name)
    ?.models.find((model) => model.modelId === modelId);
  if (exact) return exact;

  if (configured.base_url) {
    const endpoint = configured.base_url.replace(/\/+$/, "");
    const provider = catalog
      .providers()
      .find(
        (candidate) =>
          candidate.kind === configured.kind &&
          candidate.base_url?.replace(/\/+$/, "") === endpoint,
      );
    const endpointMatch = provider?.models.find((model) => model.modelId === modelId);
    if (endpointMatch) return endpointMatch;
  }

  return catalog.fill(configured.kind, modelId);
}

export function catalogProviderFromProtocol(p: ProtoCatalogProvider): CatalogProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind as ProviderKind,
    ...(p.base_url !== undefined ? { base_url: p.base_url } : {}),
    ...(p.api_key_env !== undefined ? { api_key_env: p.api_key_env } : {}),
    needsBaseUrl: p.needs_base_url,
    models: p.models.map(toModel),
  };
}

/**
 * Derive a filesystem/settings-safe provider name from a catalog id, disambiguating
 * against `taken` with a `-2`, `-3`, ... suffix.
 */
function safeName(id: string, taken: ReadonlySet<string>): string {
  const base =
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Build the UI lookup object from a loaded (kernel) ModelCatalog. */
export function createModelsCatalog(catalog: ModelCatalog): ModelsCatalog {
  const list = catalog.providers
    .map(catalogProviderFromProtocol)
    .sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(list.map((p) => [p.id, p]));

  function provider(id: string): CatalogProvider | undefined {
    return byId.get(id);
  }

  function seed(providerId: string, taken: ReadonlySet<string>): ProviderConfig | undefined {
    const p = provider(providerId);
    if (!p) return undefined;
    const config: ProviderConfig = { name: safeName(p.id, taken), kind: p.kind };
    if (p.base_url) config.base_url = p.base_url;
    if (p.api_key_env) config.api_key_env = p.api_key_env;
    return config;
  }

  function fill(kind: ProviderKind, modelId: string): CatalogModel | undefined {
    const sameKind = list.filter((p) => p.kind === kind);
    for (const p of [...sameKind, ...list]) {
      const hit = p.models.find((m) => m.modelId === modelId);
      if (hit) return hit;
    }
    return undefined;
  }

  return {
    source: catalog.source,
    providers: () => list,
    provider,
    models: (providerId) => provider(providerId)?.models ?? [],
    seed,
    fill,
  };
}

/**
 * Resolve the price of a `provider/model` reference: an exact catalog match
 * under the configured provider's name, falling back to the same model id
 * under any provider of the same kind (or any provider at all).
 *
 * @param catalog - the loaded catalog to price against.
 * @param providers - the configured providers, to resolve `modelRef`'s provider name.
 * @param modelRef - a fully-qualified `provider/model` reference.
 * @returns the resolved cost, or `undefined` if the provider or model is unknown.
 */
export function resolveModelPrice(
  catalog: ModelsCatalog,
  providers: ProviderConfig[],
  modelRef: string,
): CatalogCost | undefined {
  return resolveCatalogModel(catalog, providers, modelRef)?.cost;
}
