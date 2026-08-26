/**
 * `@clarvis/llm/adapter` — the AI SDK backend itself.
 *
 * @remarks Importing this entry loads all four provider SDKs. That is its whole
 * purpose: it is the eager half of the split described in `./index.ts`, reached
 * by {@link createAiSdkProvider}'s dynamic import and by callers that want the
 * adapter directly (tests, and a host constructing one by hand).
 */

export { AiSdkAdapter } from "./ai-sdk-adapter.ts";
export type {
  AiSdkGuardrails,
  AiSdkProviderConfig,
  SubscriptionRequestAuth,
} from "./ai-sdk-adapter.ts";
export {
  createBoundedFetch,
  DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES,
  ProviderResponseLimitError,
} from "./ai-sdk/bounded-fetch.ts";
export { createStreamMetrics, streamMetrics } from "./stream-metrics.ts";
export type { StreamMetrics } from "./stream-metrics.ts";
