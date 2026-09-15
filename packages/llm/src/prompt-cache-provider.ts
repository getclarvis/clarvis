import type { PromptCacheTtl } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";
import { composePromptCacheKey, type PromptCacheIdentity } from "@clarvis/capability";

/** Persisted session/instance identity and independent provider cache lifetime. */
export interface PromptCacheDefaults {
  identity: PromptCacheIdentity;
  promptCacheTtl: PromptCacheTtl;
}

/**
 * Bind the session and compose affinity from each effective agent instance.
 *
 * @remarks A child may supply its persisted instance ID; raw cache-key overrides
 * cannot reintroduce shared affinity. Explicit per-call TTL remains independent.
 */
export function withPromptCacheDefaults(
  inner: LLMProvider,
  defaults: PromptCacheDefaults,
): LLMProvider {
  return {
    call(params: LLMCallParams): Promise<LLMCallResult> {
      const identity = {
        sessionId: defaults.identity.sessionId,
        agentInstanceId: params.agentInstanceId ?? defaults.identity.agentInstanceId,
      };
      return inner.call({
        ...params,
        ...identity,
        promptCacheKey: composePromptCacheKey(identity),
        ...(params.promptCacheTtl === undefined ? { promptCacheTtl: defaults.promptCacheTtl } : {}),
      });
    },
  };
}
