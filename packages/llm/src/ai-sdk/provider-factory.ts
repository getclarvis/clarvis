import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import {
  ProviderError,
  type LiveMessage,
  type Logger,
  type ResolvedProviderConfig,
} from "@clarvis/capability";
import {
  openAICompatibleSettings,
  resolveConfiguredHeaders,
} from "../openai-compatible-request.ts";
import { createBoundedFetch } from "./bounded-fetch.ts";
import { convertCompatibleUsage } from "./compatible-usage.ts";
import { withResponsesReplayIds } from "./responses-replay.ts";
import type { SerializedPrefixWatch } from "./request-prefix.ts";

export interface ProviderFactoryDependencies {
  resolveRegistryKey?: (name: string) => string | undefined;
  resolveSubscription?: (
    scheme: "openai-codex" | "xai-grok",
    signal?: AbortSignal,
    context?: { conversationKey?: string },
  ) => Promise<{ apply(input: string | URL | Request, init?: RequestInit): Promise<Response> }>;
  boundedFetch: typeof globalThis.fetch;
  prefixWatch: SerializedPrefixWatch;
  maxResponseBytes: number;
  maxSseEventBytes: number;
  logger: Logger;
}

/**
 * Builds one SDK provider client from the resolved configuration and current credentials.
 * Subscription authorization remains deferred until the physical fetch, so replacement
 * or revocation between calls is observed by the host resolver.
 *
 * @throws {@link ProviderError} of kind `"client"` for a missing required key,
 *   an unresolved configured header, or an invalid compatible endpoint.
 */
export function buildRegistryFactory(
  cfg: ResolvedProviderConfig,
  conversationKey: string | undefined,
  messages: readonly LiveMessage[],
  deps: ProviderFactoryDependencies,
): { factory: (modelId: string) => LanguageModel; apiKeyPresent: boolean } {
  const lookup = deps.resolveRegistryKey ?? ((name: string) => process.env[name]);
  const apiKey = cfg.apiKeyEnv !== undefined ? lookup(cfg.apiKeyEnv) : undefined;
  const apiKeyPresent = apiKey !== undefined && apiKey.length > 0;
  const baseURL = cfg.baseUrl;
  const headers = resolveConfiguredHeaders(cfg.headers, lookup);
  const common = {
    ...(baseURL ? { baseURL } : {}),
    ...(headers !== undefined ? { headers } : {}),
    fetch: deps.boundedFetch,
  };
  const requireKey = (): string => {
    if (!apiKey) {
      throw new ProviderError(
        `Provider kind '${cfg.kind}' requires api_key_env to name a set environment variable.`,
        { kind: "client" },
      );
    }
    return apiKey;
  };
  /**
   * A provider that *names* a credential variable must actually have it.
   *
   * @remarks `openai-compatible` deliberately does not call
   * {@link requireKey}: a local llama.cpp or ollama endpoint needs no
   * credential, and demanding one would make those unusable. But when the
   * configuration names an `api_key_env` and that variable is unset, the
   * request went out unauthenticated and came back as the *remote* 401 —
   * which on one popular gateway reads as a cookie-authentication failure,
   * naming neither the provider, nor the variable, nor the fact that the
   * cause is entirely local. Failing here says which variable to set.
   */
  if (cfg.apiKeyEnv !== undefined && !apiKey) {
    throw new ProviderError(
      `This provider declares api_key_env '${cfg.apiKeyEnv}', but that environment variable ` +
        `is not set. Set it, or remove api_key_env for an endpoint that needs no key.`,
      { kind: "client" },
    );
  }
  switch (cfg.kind) {
    case "openai":
      return {
        factory: createOpenAI({
          apiKey: requireKey(),
          ...common,
          fetch: withResponsesReplayIds(deps.boundedFetch, messages),
        }),
        apiKeyPresent,
      };
    case "openai-compatible":
      return {
        factory: createOpenAICompatible({
          ...openAICompatibleSettings(cfg, headers, apiKey),
          convertUsage: convertCompatibleUsage,
          fetch: deps.boundedFetch,
        }),
        apiKeyPresent,
      };
    case "anthropic":
      return { factory: createAnthropic({ apiKey: requireKey(), ...common }), apiKeyPresent };
    case "google":
      return {
        factory: createGoogleGenerativeAI({ apiKey: requireKey(), ...common }),
        apiKeyPresent,
      };
    case "openai-codex":
    case "xai-grok":
      return buildSubscriptionFactory(cfg.kind, conversationKey, messages, deps);
  }
}

function buildSubscriptionFactory(
  scheme: "openai-codex" | "xai-grok",
  conversationKey: string | undefined,
  messages: readonly LiveMessage[],
  deps: ProviderFactoryDependencies,
): { factory: (modelId: string) => LanguageModel; apiKeyPresent: false } {
  const resolve = deps.resolveSubscription;
  if (resolve === undefined) {
    throw new ProviderError(
      `Provider kind '${scheme}' requires the kernel subscription resolver; an API key cannot satisfy subscription billing.`,
      { kind: "client" },
    );
  }
  const subscriptionFetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const auth = await resolve(scheme, init?.signal ?? undefined, {
      ...(conversationKey === undefined ? {} : { conversationKey }),
    });
    return auth.apply(input, init);
  }) as typeof globalThis.fetch;
  const fetch = createBoundedFetch({
    fetch: withResponsesReplayIds(deps.prefixWatch.wrap(subscriptionFetch), messages),
    maxResponseBytes: deps.maxResponseBytes,
    maxSseEventBytes: deps.maxSseEventBytes,
    logger: deps.logger,
  });
  const client = createOpenAI({
    apiKey: "subscription-placeholder-never-sent",
    baseURL:
      scheme === "openai-codex"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://cli-chat-proxy.grok.com/v1",
    fetch,
  });
  return { factory: (modelId) => client.responses(modelId), apiKeyPresent: false };
}
