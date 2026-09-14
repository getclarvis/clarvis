import {
  ValidationError,
  type ModelExecutionInfo,
  type ModelExecutionResolver,
  type ProviderConfig,
} from "@clarvis/capability";

/** Refuse transport declarations when the host owns an exact execution catalog. */
export function rejectCatalogProviders(
  providers: readonly ProviderConfig[] | undefined,
  resolver: ModelExecutionResolver | undefined,
): void {
  if (resolver !== undefined && (providers?.length ?? 0) > 0) {
    throw new ValidationError(
      "invalid_provider_config",
      "providers must be empty when a model execution resolver is supplied",
    );
  }
}

/** Resolve an exact pair without admitting an alias, fallback, or native transport. */
export function requireModelExecution(
  resolver: ModelExecutionResolver,
  provider: string,
  model: string,
): ModelExecutionInfo {
  const info = resolver.resolve(provider, model);
  if (info === undefined || info.provider !== provider || info.model !== model) {
    throw new ValidationError(
      "unknown_model",
      `Model '${provider}/${model}' is not in the execution catalog`,
      { provider, model },
    );
  }
  return info;
}
