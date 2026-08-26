import {
  generateText,
  Output,
  streamText,
  type GenerateTextEndEvent,
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
  AssistantTextPart,
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  Logger,
  ResolvedProviderConfig,
} from "@clarvis/capability";
import { levelEnabled, NOOP_LOGGER, ProviderError } from "@clarvis/capability";
import { classifyProviderError } from "./classify-provider-error.ts";
import { toModelMessages } from "./to-model-messages.ts";
import { openAICompatibleSettings, resolveConfiguredHeaders } from "./openai-compatible-request.ts";
import { makeDeltaBatcher, makeToolInputReporter } from "./ai-sdk/streaming.ts";
import { buildCallResult, normalizeUsage } from "./ai-sdk/result.ts";
import { buildRequestOptions, type RequestDiagnostics } from "./ai-sdk/request-options.ts";
import { toProviderError } from "./ai-sdk/errors.ts";
import {
  createBoundedFetch,
  DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES,
} from "./ai-sdk/bounded-fetch.ts";
import {
  modelCallTimeoutBridgeOf,
  type ModelCallTimeoutBridge,
} from "./model-call-timeout-bridge.ts";

/**
 * Test and host seams for {@link AiSdkAdapter}: override how API keys are looked
 * up (`resolveRegistryKey`, defaulting to `process.env`) and swap the AI SDK's
 * `generateText`/`streamText` for doubles.
 */
export interface AiSdkProviderConfig {
  resolveRegistryKey?: (envVar: string) => string | undefined;
  generateText?: typeof generateText;
  streamText?: typeof streamText;
  /** Fetch seam used by all four SDK clients, wrapped by the response bounds. */
  fetch?: typeof globalThis.fetch;
  /** Resolve kernel-owned subscription authorization at the physical fetch boundary. */
  resolveSubscription?: (
    scheme: "openai-codex" | "xai-grok",
    signal?: AbortSignal,
    context?: { conversationKey?: string },
  ) => Promise<SubscriptionRequestAuth>;
  /**
   * Where the adapter's operator diagnostics go; defaults to discarding them.
   *
   * @remarks Normalized to {@link NOOP_LOGGER} at construction so no call site
   *   in the adapter is optionally chained.
   */
  logger?: Logger;
}

/** Token-opaque request authority supplied by the kernel subscription manager. */
export interface SubscriptionRequestAuth {
  readonly scheme: "openai-codex" | "xai-grok";
  apply(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * The transport bounds a host may tighten on every provider call this adapter
 * makes. Each is optional and falls back to the package default.
 */
export interface AiSdkGuardrails {
  /** Per-call deadline used when the call itself names none. */
  timeoutMs?: number;
  /** Ceiling on a single non-streaming response body. */
  maxResponseBytes?: number;
  /** Ceiling on one server-sent event, so a stream cannot buffer unbounded. */
  maxSseEventBytes?: number;
}

type ModelFactory = (modelId: string) => LanguageModel;

/**
 * The host of a configured base URL, and nothing else.
 *
 * @param baseUrl - the operator's endpoint override, when there is one.
 * @returns the host (with its port), or `undefined` when there is no URL or it
 *   does not parse.
 * @remarks A base URL is not safe to log whole. Operators do put a token in a
 *   query string, and a gateway's path is routing detail; the host is the one
 *   part that answers which endpoint a call actually reached.
 */
function hostOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

/**
 * Derives the effective abort signal for a call, layering a per-call timeout over
 * the caller's parent signal.
 *
 * @returns `signal` (the parent when no positive timeout is set, else the two
 *   `AbortSignal.any`-combined), `timedOut()` reporting whether the timeout —
 *   rather than the parent — fired, and `cleanup()` to clear the timer.
 */
function timeoutAbort(
  timeoutMs: number | undefined,
  parent: AbortSignal | undefined,
  bridge: ModelCallTimeoutBridge | undefined,
): { signal: AbortSignal | undefined; timedOut: () => boolean; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: parent, timedOut: () => false, cleanup: () => {} };
  }
  const ctrl = new AbortController();
  let did = false;
  const timer = setTimeout(() => {
    did = true;
    ctrl.abort(bridge?.markTimedOut(timeoutMs));
  }, timeoutMs);
  const unregisterCleanup = bridge?.registerCleanup(() => clearTimeout(timer));
  const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal;
  return {
    signal,
    timedOut: () => did,
    cleanup: () => {
      clearTimeout(timer);
      unregisterCleanup?.();
    },
  };
}

/**
 * The concrete {@link LLMProvider} over the Vercel AI SDK — builds the right
 * `@ai-sdk/*` client from a {@link ResolvedProviderConfig}, translates params to
 * the SDK call shape, streams or generates, and maps every failure to a
 * {@link ProviderError}.
 *
 * @remarks This is the base backend the loop wraps with retry, logging, and
 *   prompt-cache decorators. Anthropic calls get rolling ephemeral cache
 *   breakpoints; a per-call or default timeout is layered onto the caller's
 *   abort signal.
 */
export class AiSdkAdapter implements LLMProvider {
  private readonly config: AiSdkProviderConfig;
  private readonly defaultTimeoutMs?: number;
  private readonly boundedFetch: typeof globalThis.fetch;
  private readonly logger: Logger;
  private readonly maxResponseBytes: number;
  private readonly maxSseEventBytes: number;
  /**
   * The `(provider, model)` pairs already described by `llm.provider.resolved`.
   *
   * @remarks Memoized per pair rather than per call because the record is a
   *   description of a *configuration*, not of a request: the same seven fields
   *   on every iteration of every run would bury the one line that reports a
   *   pair whose configuration is wrong. The key space is the operator's
   *   provider catalog, so it is small and finite by construction.
   */
  private readonly describedModels = new Set<string>();

  /**
   * @param config - test/host seams; see {@link AiSdkProviderConfig}.
   * @param guardrails - the three transport bounds; see
   *   {@link AiSdkGuardrails}. All three are applied: `timeoutMs` becomes the
   *   per-call default when a call sets none, and the other two are handed to
   *   {@link createBoundedFetch}, each falling back to its package default.
   */
  constructor(config: AiSdkProviderConfig = {}, guardrails: AiSdkGuardrails = {}) {
    this.config = config;
    this.defaultTimeoutMs = guardrails.timeoutMs;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.maxResponseBytes = guardrails.maxResponseBytes ?? DEFAULT_PROVIDER_MAX_RESPONSE_BYTES;
    this.maxSseEventBytes = guardrails.maxSseEventBytes ?? DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES;
    this.boundedFetch = createBoundedFetch({
      fetch: config.fetch,
      maxResponseBytes: this.maxResponseBytes,
      maxSseEventBytes: this.maxSseEventBytes,
      logger: this.logger,
    });
  }

  private resolveRegistryModel(
    cfg: ResolvedProviderConfig,
    modelId: string,
    provider: string,
    conversationKey?: string,
  ): LanguageModel {
    const built = this.buildRegistryFactory(cfg, conversationKey);
    const model = built.factory(modelId);
    this.describeResolvedModel(cfg, modelId, provider, built.apiKeyPresent);
    return model;
  }

  /**
   * Says once, per `(provider, model)`, what configuration that pair resolved
   * to.
   *
   * @param cfg - the resolved provider entry the client was built from.
   * @param modelId - the model this pair names.
   * @param provider - the provider token from the run request.
   * @remarks Emitted *after* the factory runs, so a pair whose configuration is
   *   rejected outright — an unset key variable, a missing `baseUrl` — reports
   *   as the thrown {@link ProviderError} it already is rather than as a line
   *   claiming it resolved.
   *
   *   `base_url` is reduced to its host. The rest of a base URL is a path a
   *   gateway routes on and a query string operators do put credentials in;
   *   the host is the part that answers "which endpoint did this actually go
   *   to". Headers are reported by **name** only, and the API key by presence,
   *   for the same reason.
   */
  private describeResolvedModel(
    cfg: ResolvedProviderConfig,
    modelId: string,
    provider: string,
    apiKeyPresent: boolean,
  ): void {
    if (!levelEnabled(this.logger, "debug")) return;
    const key = `${provider}\u0000${modelId}`;
    if (this.describedModels.has(key)) return;
    this.describedModels.add(key);
    const baseUrlHost = hostOf(cfg.baseUrl);
    this.logger.debug(
      {
        event: "llm.provider.resolved",
        provider,
        model: modelId,
        kind: cfg.kind,
        ...(baseUrlHost !== undefined ? { base_url: baseUrlHost } : {}),
        ...(cfg.apiKeyEnv !== undefined ? { api_key_env: cfg.apiKeyEnv } : {}),
        api_key_present: apiKeyPresent,
        header_names: Object.keys(cfg.headers ?? {}),
        ...(cfg.promptCache !== undefined ? { prompt_cache: cfg.promptCache } : {}),
      },
      "provider client built for this model; every call on this pair uses it",
    );
  }

  /**
   * Builds the SDK model factory for a resolved provider, selecting the client by
   * `kind`, reading the API key from the configured env var, and resolving the
   * configured `headers` through the same lookup.
   *
   * @throws {@link ProviderError} of kind `"client"` when a key-requiring kind's
   *   `apiKeyEnv` names an unset variable, when a configured header references an
   *   unset variable, or when an `openai-compatible` provider has no `baseUrl`.
   * @remarks Headers resolve through `resolveRegistryKey` rather than
   *   `process.env` directly: it is the package's published host/test seam and
   *   the adapter's only door to the environment, so a host that resolves keys
   *   from a vault resolves header variables from the same place.
   *
   *   `body` and the cache markers are honoured only by `openai-compatible`,
   *   through `transformRequestBody`. The other three SDKs expose no equivalent
   *   seam, which is why a settings schema refuses `body` on them outright
   *   rather than dropping it silently here.
   */
  private buildRegistryFactory(
    cfg: ResolvedProviderConfig,
    conversationKey?: string,
  ): {
    factory: ModelFactory;
    apiKeyPresent: boolean;
  } {
    const lookup = this.config.resolveRegistryKey ?? ((name: string) => process.env[name]);
    const apiKey = cfg.apiKeyEnv !== undefined ? lookup(cfg.apiKeyEnv) : undefined;
    const apiKeyPresent = apiKey !== undefined && apiKey.length > 0;
    const baseURL = cfg.baseUrl;
    const headers = resolveConfiguredHeaders(cfg.headers, lookup);
    const common = {
      ...(baseURL ? { baseURL } : {}),
      ...(headers !== undefined ? { headers } : {}),
      fetch: this.boundedFetch,
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
        return { factory: createOpenAI({ apiKey: requireKey(), ...common }), apiKeyPresent };
      case "openai-compatible":
        return {
          factory: createOpenAICompatible({
            ...openAICompatibleSettings(cfg, headers, apiKey),
            fetch: this.boundedFetch,
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
      case "xai-grok": {
        const resolve = this.config.resolveSubscription;
        if (resolve === undefined) {
          throw new ProviderError(
            `Provider kind '${cfg.kind}' requires the kernel subscription resolver; an API key cannot satisfy subscription billing.`,
            { kind: "client" },
          );
        }
        const scheme = cfg.kind;
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
          fetch: subscriptionFetch,
          maxResponseBytes: this.maxResponseBytes,
          maxSseEventBytes: this.maxSseEventBytes,
          logger: this.logger,
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
    }
  }

  /**
   * Reports what this request asked the provider for, and warns when a cache
   * breakpoint the caller asked for did not survive assembly.
   *
   * @param params - the call inputs, for the provider/model join keys.
   * @param diagnostics - what {@link buildRequestOptions} already decided.
   * @param stripImages - whether this model's missing `"vision"` capability
   *   removed image parts from the transcript.
   * @remarks Nothing here re-reads the message array. A lost breakpoint is a
   *   `warn` rather than a `debug` because its cost is not the request it
   *   happened on: an unwritten prefix means every later request re-sends and
   *   re-bills the whole conversation, and no other layer can see it happen.
   */
  private reportRequest(
    params: LLMCallParams,
    diagnostics: RequestDiagnostics,
    stripImages: boolean,
  ): void {
    const { cache, tuning } = diagnostics;
    const join = { provider: params.provider, model: params.model };
    const lost =
      cache.marked !== "none" && cache.requested_breakpoints >= 1 && cache.applied_breakpoints === 0
        ? "none_markable"
        : cache.marked !== "none" &&
            cache.requested_breakpoints >= 2 &&
            cache.applied_breakpoints === 1
          ? "collapsed"
          : undefined;
    if (lost !== undefined) {
      this.logger.warn(
        { event: "llm.cache.breakpoint_lost", ...join, ...cache, reason: lost },
        "a requested prompt-cache breakpoint did not reach the request; later calls re-send the whole prefix uncached",
      );
    }
    if (!levelEnabled(this.logger, "debug")) return;
    this.logger.debug(
      { event: "llm.cache.request", ...join, ...cache },
      "prompt-cache markers assembled for this request; the provider bills the unmarked prefix in full",
    );
    this.logger.debug(
      { event: "llm.request.tuning", model: params.model, ...tuning, images_stripped: stripImages },
      "reasoning and output caps resolved for this request; the model answers within them",
    );
  }

  /**
   * Runs one model call: resolves the client, converts messages/tools/tuning,
   * then either streams (when `onStreamDelta` is set or the provider requires
   * streaming, batching deltas through {@link makeDeltaBatcher}) or generates
   * in one shot, returning the aggregate {@link LLMCallResult}.
   *
   * @param params - the call inputs; see {@link LLMCallParams}.
   * @returns the normalized result once the stream is fully drained (or the
   *   generation resolves).
   * @throws {@link ProviderError} for a missing `providerConfig`, a per-call
   *   timeout (kind from {@link classifyProviderError}), a surfaced stream error,
   *   or any transport/API failure normalized via {@link toProviderError}.
   * @remarks Streaming aggregate promises are pre-attached with swallowing
   *   `catch`es so a stream error surfaces through the loop rather than as an
   *   unhandled rejection; images are stripped when the model lacks the
   *   `"vision"` capability; SDK-level retries are disabled (`maxRetries: 0`) so
   *   {@link withTransportRetry} owns retry policy.
   */
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    if (!params.providerConfig) {
      throw new ProviderError(
        `Provider '${params.provider}' has no resolved configuration; declare it in providers[].`,
        { kind: "client" },
      );
    }
    const model = this.resolveRegistryModel(
      params.providerConfig,
      params.model,
      params.provider,
      params.promptCacheKey,
    );
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const { signal, timedOut, cleanup } = timeoutAbort(
      timeoutMs,
      params.signal,
      modelCallTimeoutBridgeOf(params),
    );

    const stripImages = !(params.capabilities?.has("vision") ?? true);

    let batcher: ReturnType<typeof makeDeltaBatcher> | undefined;
    let outputObserved = false;
    let partialUsage: LanguageModelUsage | undefined;
    try {
      const modelMessages = toModelMessages(params.messages, { stripImages });
      const { request, diagnostics } = buildRequestOptions(params, modelMessages);
      this.reportRequest(params, diagnostics, stripImages);
      const callArgs = {
        model,
        ...request,
        ...(signal ? { abortSignal: signal } : {}),
        maxRetries: 0,
      };

      const providerRequiresStream = params.providerConfig.kind === "openai-codex";
      if (!params.onStreamDelta && !providerRequiresStream) {
        const result = await (this.config.generateText ?? generateText)(callArgs);
        const normalized = buildCallResult(result);
        return params.providerConfig?.kind === "openai-codex" ||
          params.providerConfig?.kind === "xai-grok"
          ? { ...normalized, billing_source: "subscription" }
          : normalized;
      }

      let streamError: unknown;
      let aggregate: GenerateTextEndEvent | undefined;
      const streamedTextOrder: string[] = [];
      const streamedTextParts = new Map<
        string,
        { text: string; providerOptions?: ProviderMetadata }
      >();
      const retainTextPart = (
        id: string,
        text: string,
        providerOptions?: ProviderMetadata,
      ): void => {
        const current = streamedTextParts.get(id);
        if (current === undefined) streamedTextOrder.push(id);
        streamedTextParts.set(id, {
          text: `${current?.text ?? ""}${text}`,
          ...(providerOptions !== undefined
            ? { providerOptions }
            : current?.providerOptions !== undefined
              ? { providerOptions: current.providerOptions }
              : {}),
        });
      };
      const textOutput = Output.text();
      const nonRetainingTextOutput = {
        ...textOutput,
        parsePartialOutput: ({ text }: { text: string }) =>
          Promise.resolve({ partial: text.length }),
      };
      const streamStartedAt = Date.now();
      /**
       * Reports time-to-first-token exactly once per call.
       *
       * @remarks Called only from the `!outputObserved` arm of each part
       * branch, so the per-delta path costs one boolean test — the same test
       * that used to be an unconditional store. A `logger.debug` per delta is
       * forbidden outright: this loop runs thousands of times per call at
       * roughly a millisecond apart, and the bindings object would be
       * allocated before any backend saw the level. Per-chunk telemetry belongs
       * to the `streamMetrics` counter sink.
       */
      const firstOutput = (channel: string): void => {
        outputObserved = true;
        this.logger.debug(
          {
            event: "llm.stream.first_token",
            provider: params.provider,
            model: params.model,
            ttft_ms: Date.now() - streamStartedAt,
            channel,
          },
          "the provider started emitting; the turn is now streaming to the user",
        );
      };
      const result = (this.config.streamText ?? streamText)({
        ...callArgs,
        output: nonRetainingTextOutput,
        onError: ({ error }) => {
          streamError ??= error;
        },
        onStepEnd: (step) => {
          partialUsage = step.usage;
        },
        onEnd: (event) => {
          aggregate = event;
          partialUsage = event.usage;
        },
      });

      batcher = makeDeltaBatcher(params.onStreamDelta ?? (() => undefined));
      const toolInput = params.onToolInputDelta
        ? makeToolInputReporter(params.onToolInputDelta)
        : undefined;
      for await (const part of result.stream) {
        if (part.type === "text-start" || part.type === "text-end") {
          retainTextPart(part.id, "", part.providerMetadata);
        } else if (part.type === "text-delta") {
          retainTextPart(part.id, part.text, part.providerMetadata);
          if (!outputObserved) firstOutput("text");
          batcher.push("text", part.text);
        } else if (part.type === "reasoning-delta") {
          if (!outputObserved) firstOutput("reasoning");
          batcher.push("reasoning", part.text);
        } else if (part.type === "tool-input-start") {
          if (!outputObserved) firstOutput("tool_input");
          toolInput?.start(part.id, part.toolName);
        } else if (part.type === "tool-input-delta") {
          if (!outputObserved) firstOutput("tool_input");
          toolInput?.delta(part.id, part.delta);
        } else if (part.type === "tool-input-end") {
          if (!outputObserved) firstOutput("tool_input");
          toolInput?.end(part.id);
        } else if (part.type === "finish-step") {
          partialUsage = part.usage;
        } else if (part.type === "finish") {
          partialUsage = part.totalUsage;
        } else if (part.type === "tool-call" || part.type === "file" || part.type === "source") {
          if (!outputObserved) firstOutput(part.type === "tool-call" ? "tool_call" : part.type);
        } else if (part.type === "error") streamError ??= part.error;
      }
      batcher.flush();

      if (streamError !== undefined) {
        const attemptCost = {
          streamStarted: outputObserved || batcher.emitted(),
          ...(partialUsage !== undefined ? { partialUsage: normalizeUsage(partialUsage) } : {}),
        };
        /**
         * The timeout has to be recognised *here*. Wrapping unconditionally
         * would produce a `ProviderError`, which the outer catch rethrows
         * verbatim — so the `timedOut()` branch below would never see a
         * timed-out stream, and the abort's own message matches no network
         * signal, classifying a retryable timeout as a permanent `client`
         * fault.
         */
        if (timedOut()) {
          const c = classifyProviderError({ timedOut: true });
          throw new ProviderError(`Model call exceeded the per-call timeout of ${timeoutMs}ms.`, {
            kind: c.kind,
            ...attemptCost,
          });
        }
        throw toProviderError(streamError, attemptCost, this.logger);
      }

      if (aggregate === undefined) {
        const streamStarted = outputObserved || batcher.emitted();
        const partial = partialUsage !== undefined ? normalizeUsage(partialUsage) : undefined;
        this.logger.warn(
          {
            event: "llm.stream.no_aggregate",
            model: params.model,
            stream_started: streamStarted,
            partial_output_tokens: partial?.output_tokens ?? 0,
          },
          "the provider stream ended with no final result; the attempt is retried as a transient failure",
        );
        throw new ProviderError("Provider stream ended without a final aggregate result.", {
          kind: "transient",
          streamStarted,
          ...(partial !== undefined ? { partialUsage: partial } : {}),
        });
      }
      const normalized = buildCallResult(aggregate);
      const retainedStreamTextParts: AssistantTextPart[] = streamedTextOrder.flatMap((id) => {
        const part = streamedTextParts.get(id);
        if (
          part === undefined ||
          part.providerOptions === undefined ||
          part.text.trim().length === 0
        )
          return [];
        const phaseValue = part.providerOptions.openai?.phase;
        return [
          {
            text: part.text,
            ...(phaseValue === "commentary" || phaseValue === "final_answer"
              ? { phase: phaseValue }
              : {}),
            providerOptions: part.providerOptions,
          },
        ];
      });
      const withRetainedText =
        normalized.textParts === undefined && retainedStreamTextParts.length > 0
          ? { ...normalized, textParts: retainedStreamTextParts }
          : normalized;
      return params.providerConfig?.kind === "openai-codex" ||
        params.providerConfig?.kind === "xai-grok"
        ? { ...withRetainedText, billing_source: "subscription" }
        : withRetainedText;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const attemptCost = {
        streamStarted: outputObserved || batcher?.emitted() === true,
        ...(partialUsage !== undefined ? { partialUsage: normalizeUsage(partialUsage) } : {}),
      };
      if (timedOut()) {
        const c = classifyProviderError({ timedOut: true });
        throw new ProviderError(`Model call exceeded the per-call timeout of ${timeoutMs}ms.`, {
          kind: c.kind,
          ...attemptCost,
        });
      }
      throw toProviderError(err, attemptCost, this.logger);
    } finally {
      batcher?.dispose();
      cleanup();
    }
  }
}
