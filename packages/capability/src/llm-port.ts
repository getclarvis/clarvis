import type {
  AssistantTextPart,
  AssistantReasoningPart,
  LiveMessage,
  PromptCacheMode,
  PromptCacheTtl,
  ReasoningEffort,
  ReasoningSummary,
} from "./api.ts";
import type { FailureKind, NamespacedTool } from "./run.ts";

/**
 * A single tool invocation a model asked for: the provider `id` that correlates
 * the later result, the tool `name`, and its raw, unvalidated `arguments`.
 */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /**
   * A bounded preview of the payload the provider sent when it did not decode
   * to an argument object, set by the provider layer and absent otherwise.
   *
   * @remarks Its presence is the signal that `arguments` is a **substitute**
   *   (`{}`) rather than what the model asked for, so a dispatcher must refuse
   *   the call and say so instead of running it. Without this the substitution
   *   is invisible: the tool answers with a schema error naming a property the
   *   model did send, the model re-sends the identical call, and the run dies in
   *   the convergence guard.
   */
  malformedArguments?: string;
  /**
   * What the model originally asked for, when a `beforeToolUse` hook rewrote
   * this call's `arguments`.
   *
   * @remarks Its presence is the signal that `arguments` is **not** what the
   *   model sent, the same role {@link LLMToolCall.malformedArguments} plays for
   *   a payload that failed to decode. The engine never mutates the call the
   *   provider returned: the rewritten call is a separate object, so the
   *   assistant message already appended to the context keeps the model's own
   *   arguments and the request prefix stays byte-identical.
   */
  rewrittenFrom?: unknown;
}

/**
 * Provider-neutral token accounting for one call: prompt (`input_tokens`) and
 * completion (`output_tokens`) totals, plus the cache-read (`cached_tokens`) and
 * cache-write (`cache_write_tokens`) portions of the input when the provider
 * reports them (zero when it does not).
 */
export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
}

/**
 * The whole result of one model call, normalized across providers: assistant
 * `text` and `toolCalls` are present only when non-empty, `usage` is always
 * populated, and `reasoning` carries the model's thinking trace when one was
 * produced.
 */
export interface LLMCallResult {
  text?: string;
  toolCalls?: LLMToolCall[];
  usage: LLMUsage;
  reasoning?: string;
  /** Explicit billing authority when the host used renewable subscription credentials. */
  billing_source?: "subscription";
  /**
   * Provider-issued reasoning blocks to replay with this assistant turn.
   *
   * @remarks Unlike {@link LLMCallResult.reasoning}, which is display text,
   * these parts retain opaque provider metadata required for a valid
   * continuation (for example Anthropic signatures and OpenAI reasoning item
   * state). The provider adapter that produced them is also the layer that
   * interprets them on the next call.
   */
  reasoningParts?: AssistantReasoningPart[];
  /** Provider-issued assistant text blocks retained for exact continuation. */
  textParts?: AssistantTextPart[];
  /**
   * Why the model stopped, verbatim from the provider; `"length"` means the
   * response was cut off at `maxOutputTokens`.
   *
   * @remarks Optional because a caller that does not cap its output has no use
   *   for it, and because the test doubles predate it. It exists for callers
   *   that *do* cap and cannot tell a complete answer from a severed one by
   *   inspecting the text — see `summarizeContext`, where adopting a severed
   *   summary would overwrite the rolling anchor with a truncated merge.
   */
  finishReason?: string;
  /**
   * Tokens burned by attempts that failed before this one succeeded.
   *
   * @remarks Attached by {@link withTransportRetry}. `usage` is the winning
   *   attempt alone; a caller charging a budget must add this, or the ledger
   *   under-counts by exactly the amount an unhealthy provider cost — making
   *   the hard token cap least accurate precisely when a run is burning money
   *   for nothing. Absent when nothing was retried, or when no failed attempt's
   *   usage could be read.
   */
  retriedUsage?: LLMUsage;
}

/**
 * How the model is steered toward tools on a call: `"auto"` (decide freely),
 * `"required"` (must call some tool), or a forced call of one named function.
 */
export type ToolChoice = "auto" | "required" | { type: "function"; function: { name: string } };

/**
 * A provider entry resolved to what the adapter needs to build a client: its SDK
 * `kind`, an optional `baseUrl` endpoint override, and the name of the
 * environment variable (`apiKeyEnv`) holding the API key.
 *
 * @remarks Produced by {@link resolveProvider} from the run's `providers`
 *   registry; consumed by the AI SDK adapter to select and configure the client.
 *   When `resolveProvider` is given a model id the result is per-`(provider,
 *   model)` rather than per-provider: `headers`, `body` and `promptCache` are
 *   the provider's, overridden per top-level key by that model's.
 *
 *   All three are read at *client construction*, not per message — which is why
 *   they ride here rather than on {@link LLMCallParams}.
 *
 *   `headers` values are raw `${VAR}` **templates**, never resolved values, for
 *   the same reason `apiKeyEnv` is a name: this object is carried on a resolved
 *   agent profile and passed through the call-logging decorator. The adapter
 *   substitutes them against its own key lookup.
 *
 *   `promptCache` resolves as follows, and absent is deliberately not `off`:
 *
 *   | value        | `anthropic`       | `openai` / `openai-codex`       | `openai-compatible`     |
 *   | ------------ | ----------------- | -------------------------------- | ----------------------- |
 *   | `"explicit"` | cache breakpoints | `prompt_cache_breakpoint` blocks | `cache_control` blocks  |
 *   | `"implicit"` | cache breakpoints | provider-managed only            | provider-managed only   |
 *   | `"off"`      | no breakpoints    | no Clarvis markers               | no Clarvis markers      |
 *   | absent       | cache breakpoints | provider-managed only            | provider-managed only   |
 *
 *   So the explicit marker on an OpenAI-compatible endpoint is reachable only
 *   when something positively claimed the model wants one; nothing inherits it
 *   by default. The `anthropic` column is unchanged from before this field
 *   existed except that `"off"` can now switch it off. `xai-grok` is not a
 *   breakpoint column: its Responses transport uses the stable
 *   `promptCacheKey` for implicit prefix-cache routing and never receives an
 *   OpenAI `prompt_cache_breakpoint`.
 */
export interface ResolvedProviderConfig {
  kind: "openai-compatible" | "openai" | "anthropic" | "google" | "openai-codex" | "xai-grok";
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  promptCache?: PromptCacheMode;
}

/**
 * What one scheduled retry is about to do, reported before the backoff sleep.
 *
 * @remarks Mirrors the fields the retry wrapper already logs, so the trace and
 * the log agree by construction rather than by two hand-kept copies.
 */
export interface RetryInfo {
  /** 1-based retry attempt number. */
  attempt: number;
  /** The attempt cap in force for this call. */
  maxRetries: number;
  /** How long the wrapper is about to sleep, in milliseconds. */
  delayMs: number;
  /** The classified failure that triggered the retry. */
  kind: FailureKind;
  /** The bounded provider failure message that triggered the retry. */
  message: string;
  /** HTTP status, when the failure carried one. */
  status?: number;
  /** The server-advised delay, when one was parsed from the response. */
  retryAfterMs?: number;
}

/**
 * The full input to one model call: the `model` id and `provider` token, the
 * conversation `messages` and available `tools`, plus optional resolved config,
 * cancellation, tuning (tool choice, timeout, output cap, reasoning), prompt
 * caching, retry policy, and a live streaming sink.
 *
 * @remarks `capabilities` gates provider-specific features (e.g. `"vision"`);
 *   `providerConfig` is the {@link ResolvedProviderConfig} the adapter requires.
 *   `maxRetries`/`maxRetryAfterMs`/`onRetry` override the transport-retry
 *   wrapper's defaults per call.
 */
export interface LLMCallParams {
  model: string;
  messages: LiveMessage[];
  tools: NamespacedTool[];
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  capabilities?: Set<string>;
  signal?: AbortSignal;
  toolChoice?: ToolChoice;
  timeoutMs?: number;
  maxOutputTokens?: number;
  reasoningSummary?: ReasoningSummary;
  reasoningEffort?: ReasoningEffort;
  promptCacheKey?: string;
  /** How long a written prompt-cache prefix should survive; Anthropic only. */
  promptCacheTtl?: PromptCacheTtl;
  /**
   * Indices into {@link LLMCallParams.messages}, oldest first, at which to place
   * a provider prompt-cache breakpoint.
   *
   * @remarks Providers with explicit breakpoint protocols (Anthropic, native
   *   OpenAI Responses and explicitly opted-in OpenAI-compatible endpoints)
   *   read this. The adapter keeps at most the two newest usable indices,
   *   ignores any that are out of range or name a system message, and uses a
   *   provider-specific fallback when a chosen message cannot carry a marker.
   *   Supplied by
   *   `@clarvis/loop`'s `LiveContext.cacheBreakpoints`
   *   (`runtime/context/context-compaction.ts`).
   */
  cacheBreakpoints?: readonly number[];
  maxRetries?: number;
  maxRetryAfterMs?: number;
  /**
   * Called once per scheduled retry, immediately before the backoff sleep.
   *
   * @remarks Reports what the retry is about to do, so a host can both prove
   *   liveness (the run is waiting on purpose) and show it. Fired *after* the
   *   delay is computed, or `delayMs` would be a number the caller invented.
   */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Optional live streaming sink. When present, the provider streams the
   * completion and invokes this for each batched slice of output as it arrives.
   * `reset` is true on the first slice of a channel within this call, so a
   * retried call restarts the consumer's buffer. The aggregate `LLMCallResult`
   * is still returned whole; this is purely additive UI signal.
   */
  onStreamDelta?: (delta: { channel: "text" | "reasoning"; text: string; reset: boolean }) => void;
  /**
   * Optional live sink for tool calls the model is still composing. Fired once
   * per call the moment the provider names the tool, and again as its argument
   * payload grows.
   *
   * @remarks Separate from {@link LLMCallParams.onStreamDelta} rather than a
   * third channel on it, because the two signals are shaped differently and a
   * single batcher cannot carry both: a stream delta is an unkeyed slice
   * appended to one buffer, while this is keyed by `call_id` and can interleave
   * across concurrent calls within one completion. Folding them together would
   * make two tool calls in one response indistinguishable.
   *
   * `chars` is cumulative for the call, so consumers may drop or coalesce
   * freely. `chars: 0` is the announcement that the call exists — that is the
   * event which ends the blind window, since everything else about the call
   * arrives only after the whole model call returns.
   */
  onToolInputDelta?: (delta: {
    call_id: string;
    tool_name: string;
    chars: number;
    /**
     * Cumulative text, reasoning, and tool-input characters observed in this
     * physical provider stream when this report was emitted.
     *
     * @remarks This is stream liveness, not argument progress. It may advance
     *   while `chars` remains zero when a provider emits other channels after
     *   announcing a tool but before exposing its argument bytes.
     */
    stream_chars?: number;
    /** Present only on the final cumulative report for this argument stream. */
    complete?: true;
  }) => void;
}

/**
 * The single-method port every model backend implements and every decorator
 * ({@link withTransportRetry}, {@link withCallLogging}, {@link withPromptCacheDefaults})
 * wraps: take {@link LLMCallParams}, return an {@link LLMCallResult}.
 */
export interface LLMProvider {
  call(params: LLMCallParams): Promise<LLMCallResult>;
}

/**
 * Optional fields for constructing a {@link ProviderError}: the failure `kind`
 * (defaults to `"transient"`), the HTTP `status`, and a server-advised
 * `retryAfterMs` delay.
 */
export interface ProviderErrorInit {
  kind?: FailureKind;
  status?: number;
  retryAfterMs?: number;
  /**
   * Tokens the provider had already billed when the call failed, when they
   * could be read.
   *
   * @remarks Deliberately absent rather than zero when unknown. A failed
   * attempt still costs the full prompt, so treating "could not read" as
   * "cost nothing" would under-count the ledger silently — and confidently.
   */
  partialUsage?: LLMUsage;
  /**
   * Whether any output delta had reached the consumer before the failure.
   *
   * @remarks Retrying after this point re-sends and re-bills the whole prompt,
   * which at a large context dominates the cost of the turn.
   */
  streamStarted?: boolean;
}

/**
 * The normalized error every provider call rejects with, carrying the retry
 * signal the loop acts on.
 *
 * @remarks `kind` (a {@link FailureKind}) drives handling — only `"transient"`
 *   is retried by {@link withTransportRetry}; `status` is the HTTP status when
 *   known; `retryAfterMs` is a server-advised backoff. `code` is the stable
 *   `"provider_error"` discriminator.
 */
export class ProviderError extends Error {
  /** Stable machine-readable discriminator, `"provider_error"`. */
  readonly code = "provider_error" as const;
  /** The failure classification that drives retry/abort handling. */
  readonly kind: FailureKind;
  /** The HTTP status code when the failure came from an HTTP response. */
  readonly status?: number;
  /** A server-advised backoff in milliseconds, when the response carried one. */
  readonly retryAfterMs?: number;
  /** Tokens already billed by the failed attempt, when they could be read. */
  readonly partialUsage?: LLMUsage;
  /** Whether output had already begun streaming when the call failed. */
  readonly streamStarted: boolean;
  /**
   * Tokens burned by every failed attempt the retry wrapper made before giving
   * up, when any could be read.
   *
   * @remarks Attached by {@link withTransportRetry} on the error it finally
   * rethrows, so the loop can charge the ledger for work the provider billed
   * even though the call produced nothing.
   */
  accumulatedUsage?: LLMUsage;
  /**
   * @param message - human-readable error text.
   * @param init - optional {@link ProviderErrorInit}; `kind` defaults to
   *   `"transient"`.
   */
  constructor(message: string, init: ProviderErrorInit = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = init.kind ?? "transient";
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.partialUsage = init.partialUsage;
    this.streamStarted = init.streamStarted ?? false;
  }
}
