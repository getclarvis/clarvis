import type { LLMCallParams, LLMCallResult, LLMProvider, Logger } from "@clarvis/capability";

/**
 * The host seams {@link createAiSdkProvider} passes to the adapter it builds.
 */
export interface AiSdkProviderOptions {
  /**
   * Resolves a provider's API-key environment variable to its value, so a host
   * can supply credentials from somewhere other than `process.env`.
   */
  resolveRegistryKey: (name: string) => string | undefined;
  /** Resolve kernel-owned subscription authorization without exposing tokens to call DTOs. */
  resolveSubscription?: (
    scheme: "openai-codex" | "xai-grok",
    signal?: AbortSignal,
    context?: { conversationKey?: string },
  ) => Promise<{
    readonly scheme: "openai-codex" | "xai-grok";
    apply(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  }>;
  /** The default per-call timeout used when a call does not set its own. */
  timeoutMs?: number;
  /** Maximum provider response body size; defaults to 32 MiB. */
  maxResponseBytes?: number;
  /** Maximum bytes between SSE event delimiters; defaults to 4 MiB. */
  maxSseEventBytes?: number;
  /**
   * Where the adapter's operator diagnostics go; defaults to discarding them.
   *
   * @remarks Carried through as-is. Only `import type` reaches
   *   `@clarvis/capability` from here, so this entry stays free of the provider
   *   SDKs exactly as before.
   */
  logger?: Logger;
}

/**
 * Builds an {@link LLMProvider} backed by the Vercel AI SDK, deferring the
 * adapter's construction until its first `call`.
 *
 * @param opts - see {@link AiSdkProviderOptions}.
 * @returns a provider whose adapter is constructed once, lazily, on first use.
 * @remarks The laziness is the reason this lives in its own module and is the
 *   only path to the adapter that `@clarvis/llm`'s main entry offers. The four
 *   provider SDKs are the heaviest imports in the workspace, and a host that
 *   assembles its run dependencies has no reason to pay for them before a model
 *   is actually called. Reaching {@link "./adapter"} directly loads them
 *   eagerly, which is what that entry is for.
 */
export function createAiSdkProvider(opts: AiSdkProviderOptions): LLMProvider {
  let adapterPromise: Promise<LLMProvider> | undefined;
  const build = async (): Promise<LLMProvider> => {
    const { AiSdkAdapter } = await import("./ai-sdk-adapter.ts");
    return new AiSdkAdapter(
      {
        resolveRegistryKey: opts.resolveRegistryKey,
        ...(opts.resolveSubscription !== undefined
          ? { resolveSubscription: opts.resolveSubscription }
          : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      },
      {
        timeoutMs: opts.timeoutMs,
        maxResponseBytes: opts.maxResponseBytes,
        maxSseEventBytes: opts.maxSseEventBytes,
      },
    );
  };
  return {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      adapterPromise ??= build();
      const adapter = await adapterPromise;
      return adapter.call(params);
    },
  };
}
