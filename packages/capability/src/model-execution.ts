import type { ModelConfig, ProviderKind } from "./api.ts";

/** Transport-free facts for one exact provider/model execution target. */
export interface ModelExecutionInfo {
  provider: string;
  model: string;
  kind: ProviderKind;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  capabilities: ModelConfig["capabilities"];
  reasoningEfforts: ModelConfig["reasoning_efforts"];
  promptCache: ModelConfig["prompt_cache"];
}

/**
 * Host-owned closed execution catalog, independent of endpoints and credentials.
 * Unknown pairs return undefined; consumers must not fall back to native providers.
 */
export interface ModelExecutionResolver {
  resolve(provider: string, model: string): ModelExecutionInfo | undefined;
}
