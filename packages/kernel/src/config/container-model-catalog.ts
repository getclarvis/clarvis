import type { ModelExecutionInfo, ModelExecutionResolver } from "@clarvis/capability";
import type { CatalogProvider, ModelCatalogService } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import {
  parseContainerConfiguration,
  type ContainerConfiguration,
} from "./container-projection.ts";

/**
 * Resolve only the frozen logical model pairs and expose their execution metadata to the guest.
 * No SDK, catalog fetch, subscription manager, endpoint, secret or fabricated provider config exists
 * on this path. Operator catalog refresh and authentication belong exclusively to host services.
 */
export function createContainerModelCatalog(value: ContainerConfiguration): {
  resolver: ModelExecutionResolver;
  service: ModelCatalogService;
} {
  const configuration = parseContainerConfiguration(value);
  const pairs = new Map<string, ModelExecutionInfo>();
  const providers = new Map<string, CatalogProvider>();
  for (const model of configuration.modelCatalog) {
    pairs.set(JSON.stringify([model.provider, model.model]), {
      ...model,
      capabilities: model.capabilities,
      reasoningEfforts: model.reasoningEfforts,
      promptCache: model.promptCache,
    });
    let provider = providers.get(model.provider);
    if (provider === undefined) {
      provider = {
        id: model.provider,
        name: model.provider,
        kind: model.kind,
        needs_base_url: false,
        models: [],
      };
      providers.set(model.provider, provider);
    } else if (provider.kind !== model.kind) {
      throw kernelError(
        "invalid_request",
        "Container model catalog has inconsistent provider kinds",
      );
    }
    provider.models.push({
      id: model.model,
      context_window: model.contextWindowTokens,
      ...(model.maxOutputTokens === undefined ? {} : { max_output: model.maxOutputTokens }),
      ...(model.capabilities === undefined ? {} : { capabilities: [...model.capabilities] }),
      ...(model.reasoningEfforts === undefined
        ? {}
        : { reasoning_efforts: [...model.reasoningEfforts] }),
    });
  }
  const denied = async (): Promise<never> => {
    throw kernelError(
      "unsupported",
      "Container model catalog is an immutable execution projection",
    );
  };
  return {
    resolver: {
      resolve(provider, model) {
        const found = pairs.get(JSON.stringify([provider, model]));
        return found === undefined ? undefined : structuredClone(found);
      },
    },
    service: {
      get: async () => ({
        source: "projection",
        providers: structuredClone([...providers.values()]),
      }),
      refresh: denied,
      getEntitled: denied,
      refreshEntitled: denied,
    },
  };
}
