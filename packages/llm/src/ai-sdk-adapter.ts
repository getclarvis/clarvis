import { generateText, streamText, type LanguageModel } from "ai";
import type {
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  LiveMessage,
  Logger,
  ResolvedProviderConfig,
} from "@clarvis/capability";
import {
  levelEnabled,
  NOOP_LOGGER,
  ProviderError,
  ModelCallInactivityError,
} from "@clarvis/capability";
import { toModelMessages } from "./to-model-messages.ts";
import { buildRegistryFactory } from "./ai-sdk/provider-factory.ts";
import { buildCallResult } from "./ai-sdk/result.ts";
import { runStreamCall } from "./ai-sdk/stream-call.ts";
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
import type { StreamMetrics } from "./stream-metrics.ts";
import { SerializedPrefixWatch } from "./ai-sdk/request-prefix.ts";

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
  /** Host-owned stream counters; omitted adapters perform no instrumentation. */
  metrics?: Pick<StreamMetrics, "count">;
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
 * Derives the effective abort signal for a call, layering a per-call inactivity
 * timeout over the caller's parent signal.
 *
 * @returns `signal` (the parent when no positive timeout is set, else the two
 *   `AbortSignal.any`-combined), `timedOut()` reporting whether the timeout —
 *   rather than the parent — fired, `markActivity()` to reset the idle window,
 *   and `cleanup()` to clear the timer.
 * @remarks Activity only updates one timestamp. The single armed timer checks
 *   that timestamp and re-arms itself at most once per timeout window, so a
 *   high-rate provider stream does not allocate one timer per delta.
 */
function timeoutAbort(
  timeoutMs: number | undefined,
  parent: AbortSignal | undefined,
  bridge: ModelCallTimeoutBridge | undefined,
): {
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  markActivity: () => void;
  cleanup: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: parent,
      timedOut: () => false,
      markActivity: () => {},
      cleanup: () => {},
    };
  }
  const ctrl = new AbortController();
  let did = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const expire = (): void => {
    const remaining = timeoutMs - (Date.now() - lastActivityAt);
    if (remaining > 0) {
      timer = setTimeout(expire, remaining);
      return;
    }
    did = true;
    ctrl.abort(bridge?.markTimedOut(timeoutMs));
  };
  timer = setTimeout(expire, timeoutMs);
  const unregisterCleanup = bridge?.registerCleanup(() => clearTimeout(timer));
  const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal;
  return {
    signal,
    timedOut: () => did,
    markActivity: () => {
      if (!did) lastActivityAt = Date.now();
    },
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
  private readonly prefixWatch = new SerializedPrefixWatch();
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
      fetch: this.prefixWatch.wrap(config.fetch ?? globalThis.fetch),
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
    messages: readonly LiveMessage[] = [],
  ): LanguageModel {
    const built = buildRegistryFactory(cfg, conversationKey, messages, {
      resolveRegistryKey: this.config.resolveRegistryKey,
      resolveSubscription: this.config.resolveSubscription,
      boundedFetch: this.boundedFetch,
      prefixWatch: this.prefixWatch,
      maxResponseBytes: this.maxResponseBytes,
      maxSseEventBytes: this.maxSseEventBytes,
      logger: this.logger,
    });
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
   *   timeout ({@link ModelCallInactivityError}), a surfaced stream error,
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
      params.messages,
    );
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const { signal, timedOut, markActivity, cleanup } = timeoutAbort(
      timeoutMs,
      params.signal,
      modelCallTimeoutBridgeOf(params),
    );

    const stripImages = !(params.capabilities?.has("vision") ?? false);

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
        normalized.requestPrefix = this.prefixWatch.evidence(params.promptCacheKey);
        return params.providerConfig?.kind === "openai-codex" ||
          params.providerConfig?.kind === "xai-grok"
          ? { ...normalized, billing_source: "subscription" }
          : normalized;
      }

      const normalized = await runStreamCall({
        params,
        callArgs,
        stream: this.config.streamText ?? streamText,
        markActivity,
        timedOut,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        logger: this.logger,
        metrics: this.config.metrics,
      });
      normalized.requestPrefix = this.prefixWatch.evidence(params.promptCacheKey);
      return params.providerConfig.kind === "openai-codex" ||
        params.providerConfig.kind === "xai-grok"
        ? { ...normalized, billing_source: "subscription" }
        : normalized;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (timeoutMs !== undefined && timedOut()) {
        throw new ModelCallInactivityError(timeoutMs, false);
      }
      throw toProviderError(err, { streamStarted: false }, this.logger);
    } finally {
      cleanup();
    }
  }
}
