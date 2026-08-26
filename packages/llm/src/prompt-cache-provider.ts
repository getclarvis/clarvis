import type { PromptCacheTtl } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";

/**
 * The run-level prompt-cache settings a provider decorator fills in.
 *
 * @remarks `promptCacheKey` is the routing hint that keeps a run's calls landing
 *   on a cache-warm backend; `promptCacheTtl` is how long a written prefix
 *   survives.
 */
export interface PromptCacheDefaults {
  promptCacheKey: string;
  promptCacheTtl: PromptCacheTtl;
}

/**
 * Wraps a provider so every call carries the run's prompt-cache settings,
 * improving hit rates and cache lifetime across a run's calls.
 *
 * @param inner - the provider to decorate.
 * @param defaults - the run-level {@link PromptCacheDefaults}.
 * @returns a provider that forwards each call, filling in each default only
 *   where the caller left that field unset.
 * @remarks The two default **independently**: a call that pins its own key still
 *   inherits the run's TTL. Treating them as a unit would silently drop the TTL
 *   for sub-agent and compaction calls, which set their own key and flow through
 *   this same decorator.
 */
export function withPromptCacheDefaults(
  inner: LLMProvider,
  defaults: PromptCacheDefaults,
): LLMProvider {
  return {
    call(params: LLMCallParams): Promise<LLMCallResult> {
      return inner.call({
        ...params,
        ...(params.promptCacheKey === undefined ? { promptCacheKey: defaults.promptCacheKey } : {}),
        ...(params.promptCacheTtl === undefined ? { promptCacheTtl: defaults.promptCacheTtl } : {}),
      });
    },
  };
}
