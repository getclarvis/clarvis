import type {
  LLMCallResult,
  LLMUsage,
  Logger,
  ProviderError,
  TracePort,
} from "@clarvis/capability";
import type { TokenAccumulator } from "@clarvis/capability";
import { levelEnabled, NOOP_LOGGER, sanitizeErrorMessage } from "@clarvis/capability";
import type { IterationCounter, TokenLedger } from "../budget/budget.ts";
import type { AgentRole } from "@clarvis/capability";
import { addUsage } from "../usage.ts";

/**
 * Inputs to {@link recordIterationMetrics}: the completed model call, the token
 * accounting sinks (`ledger` and `usage`), the trace, the agent identity, and
 * the iteration's number/start-time/model for the emitted event.
 */
export interface IterationMetricsArgs {
  llmResult: LLMCallResult;
  ledger: TokenLedger;
  usage: TokenAccumulator;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  iterStart: number;
  model: string;
  /** The agent-bound logger `iteration.cache` is written to. */
  logger?: Logger;
  /** Per-agent-loop prompt-cache state; see {@link createCachePrefixWatch}. */
  cacheWatch?: CachePrefixWatch;
}

/**
 * Remembers how many tokens the provider last served from its prompt cache, for
 * one agent loop.
 *
 * @remarks An instance rather than a module singleton: two agents in flight
 *   would otherwise compare each other's iterations, and the break this exists
 *   to catch is per-transcript.
 */
export interface CachePrefixWatch {
  /**
   * Fold in one iteration's cache read.
   *
   * @param cachedTokens - the iteration's `cached_tokens`.
   * @returns `true` when the provider could no longer serve a prefix as long as
   *   the one it had already served, and that break has not been reported yet.
   */
  observe(cachedTokens: number): boolean;
}

/**
 * How much of the previously served prefix may go unserved before it reads as a
 * break rather than as provider block rounding.
 *
 * @remarks Relative, not absolute, so the tolerance scales with the prefix
 * instead of swamping a short one and vanishing on a long one. Bracketed by the
 * two ways it can be wrong, and they are not symmetric: too tight and ordinary
 * block quantization reports a break on a perfectly healthy run, which trains
 * the reader to ignore the warning entirely; too loose and a genuine partial
 * collapse of up to this fraction goes unreported. Since the watch does not
 * latch and reports each distinct break once, a false positive is the more
 * expensive error here — hence a tolerance well above any provider's reporting
 * granularity rather than one hugging it.
 */
const CACHE_PREFIX_LOSS = 0.1;

/**
 * Create the per-agent-loop {@link CachePrefixWatch}.
 *
 * @returns a watch that reports each distinct break once.
 * @remarks A prompt-cache prefix that collapses mid-run is the single most
 *   expensive defect the repository has measured — 2,929,430 tokens across one
 *   session — and it is invisible in aggregate, because the run still completes
 *   and the totals only look large.
 *
 *   The signal is `cached_tokens` *falling*, not the cache-read **ratio**
 *   falling. A ratio drops for reasons that have nothing to do with the prefix:
 *   one large `read_file` takes an iteration from 5000/4000 to 30000/5000 — a
 *   0.63 drop with the prefix perfectly intact. What cannot happen while the
 *   prefix holds is the provider serving *fewer* tokens than it served last
 *   iteration: an implicit cache returns the longest byte-identical prefix, and
 *   an explicit breakpoint only ever moves forward, so the served length is
 *   monotonic until something ahead of it changes.
 *
 *   The comparison is against the previous iteration's `cached_tokens` rather
 *   than its `input_tokens`, which would look like the stricter test and is in
 *   fact wrong: the trailing volatile run — the canonical block and the runtime
 *   notes — is spliced out and re-appended every iteration by design and is
 *   never inside the cached prefix, so `cached < previous input` is true of a
 *   perfectly healthy Anthropic run from its second iteration onwards.
 *   {@link CACHE_PREFIX_LOSS} absorbs the block rounding every provider reports
 *   in, and a first iteration with nothing cached arms nothing, so a provider
 *   that caches at all is the only one this can speak about.
 *
 *   It does not latch for the run. A latch spends the run's one warning on the
 *   first trip whatever caused it — a cache TTL expiring across a slow tool call
 *   trips it just as a rewrite does — and then leaves the genuine break at
 *   iteration 30 undetectable. Instead a break stays quiet only while it
 *   persists: the next iteration that does not lose ground re-arms the watch, so
 *   one break is one line and a second break is still reported.
 */
export function createCachePrefixWatch(): CachePrefixWatch {
  let previous: number | undefined;
  let reported = false;
  return {
    observe(cachedTokens: number): boolean {
      const prior = previous;
      previous = cachedTokens;
      const lost =
        prior !== undefined && prior > 0 && cachedTokens < prior * (1 - CACHE_PREFIX_LOSS);
      if (!lost) {
        reported = false;
        return false;
      }
      if (reported) return false;
      reported = true;
      return true;
    },
  };
}

/**
 * The share of an iteration's prompt that the provider served from its cache.
 *
 * @param usage - the call's normalized {@link LLMUsage}.
 * @returns `cached_tokens / input_tokens`, in `[0, 1]`; `0` when the call
 *   reported no input tokens.
 * @remarks The denominator is `input_tokens` alone. Every `@ai-sdk/*` adapter
 *   normalizes it to the FULL prompt size — cache reads, and on Anthropic and
 *   OpenAI cache writes too, are already inside it — so adding `cached_tokens`
 *   to the denominator would double-count the hits and cap the ratio at 0.5.
 *   Emitted per iteration so cache health is readable straight off the trace
 *   without post-processing.
 */
export function cacheReadRatio(usage: LLMUsage): number {
  return usage.input_tokens > 0 ? usage.cached_tokens / usage.input_tokens : 0;
}

/**
 * Charge a completed iteration's token usage and record its end-of-iteration
 * trace event(s).
 *
 * @param args - see {@link IterationMetricsArgs}.
 * @remarks Consumes the call's usage into both the {@link TokenLedger} and the
 *   {@link TokenAccumulator}, then records a `subagent_iteration` or
 *   `lead_iteration` event (per {@link AgentRole}) carrying token counts and the
 *   response text; when the call produced reasoning, an additional
 *   `model_reasoning` event is recorded.
 *
 *   `retriedUsage` — what failed attempts burned before this one succeeded — is
 *   charged to the ledger and the accumulator alongside the winning attempt.
 *   The provider bills a retried prompt in full every time, so leaving it out
 *   under-counted the budget by exactly the amount an unhealthy provider cost.
 *   It is deliberately **not** folded into the recorded iteration event: that
 *   event reports what the model produced, and inflating its `input_tokens`
 *   with a call that produced nothing would make the per-iteration trace lie
 *   about the turn. The spend shows up in the ledger and in the run totals,
 *   which is where a budget question is answered.
 */
export function recordIterationMetrics(args: IterationMetricsArgs): void {
  const {
    llmResult,
    ledger,
    usage,
    trace,
    agent,
    subagentInstanceId,
    iteration,
    iterStart,
    model,
  } = args;
  const logger = args.logger ?? NOOP_LOGGER;
  const responsePhase = llmResult.textParts
    ?.map((part) => part.phase)
    .filter((phase) => phase !== undefined)
    .at(-1);

  ledger.consume(llmResult.usage);
  addUsage(usage, llmResult.usage);
  if (llmResult.retriedUsage !== undefined) {
    ledger.consume(llmResult.retriedUsage);
    addUsage(usage, llmResult.retriedUsage);
  }

  trace.record(agent === "subagent" ? "subagent_iteration" : "lead_iteration", {
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration,
    started_at: iterStart,
    ended_at: trace.now(),
    model,
    input_tokens: llmResult.usage.input_tokens,
    output_tokens: llmResult.usage.output_tokens,
    cached_tokens: llmResult.usage.cached_tokens,
    cache_write_tokens: llmResult.usage.cache_write_tokens,
    cache_read_ratio: cacheReadRatio(llmResult.usage),
    response: llmResult.text ?? "",
    ...(responsePhase !== undefined ? { response_phase: responsePhase } : {}),
  });

  reportIterationCache(logger, args, cacheReadRatio(llmResult.usage));

  if (llmResult.reasoning) {
    trace.record("model_reasoning", {
      agent,
      ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
      iteration,
      model,
      text: llmResult.reasoning,
    });
  }
}

/**
 * Write the per-iteration prompt-cache line, escalating a lost prefix to `warn`.
 *
 * @param logger - the agent-bound logger.
 * @param args - the iteration's metrics arguments.
 * @param ratio - the iteration's cache-read ratio, reported for readability.
 * @remarks The four numbers are already computed for the trace, so the cost here
 *   is the bindings object alone — which is why the `debug` case is guarded by
 *   {@link levelEnabled} rather than left to the backend: the object is
 *   allocated at the call site, before any backend sees the level, and this runs
 *   on every iteration of every agent.
 *
 *   The escalation is decided by {@link CachePrefixWatch} on `cached_tokens`
 *   alone, never on `ratio`: the ratio is here because it reads well beside the
 *   counts, and it moves for reasons a healthy prefix produces.
 *
 *   The escalation exists because the asymmetric case is silent by construction.
 *   Commit `0bb6dce` fixed a cache that was written every iteration and could
 *   never be read, and records that the asymmetry "went unnoticed" — the run
 *   completes either way and only the bill changes.
 */
function reportIterationCache(logger: Logger, args: IterationMetricsArgs, ratio: number): void {
  const lost = args.cacheWatch?.observe(args.llmResult.usage.cached_tokens) === true;
  if (!lost && !levelEnabled(logger, "debug")) return;
  const fields = {
    event: "iteration.cache",
    iteration: args.iteration,
    input_tokens: args.llmResult.usage.input_tokens,
    cached_tokens: args.llmResult.usage.cached_tokens,
    ratio,
  };
  if (lost) {
    logger.warn(
      fields,
      "the provider served a shorter cached prefix than it served last iteration; " +
        "something rewrote the transcript ahead of the tail and every token behind it is billed again",
    );
    return;
  }
  logger.debug(fields, "the iteration's prompt-cache hit rate");
}

/**
 * Record the `*_iteration_started` marker event at the top of an iteration,
 * choosing the subagent or lead variant by {@link AgentRole}.
 */
function recordIterationStarted(args: {
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  iterStart: number;
  model: string;
}): void {
  const { trace, agent, subagentInstanceId, iteration, iterStart, model } = args;
  trace.record(agent === "subagent" ? "subagent_iteration_started" : "lead_iteration_started", {
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration,
    started_at: iterStart,
    model,
  });
}

/**
 * Advance the iteration counter and emit the iteration-started trace event.
 *
 * @param counter - the per-agent {@link IterationCounter}, advanced by one.
 * @param args - the trace, agent identity, and model for the start event.
 * @returns the new one-based `iteration` number and its `iterStart` timestamp
 *   (from the trace clock), to be threaded through the rest of the iteration.
 */
export function startIteration(
  counter: IterationCounter,
  args: { trace: TracePort; agent: AgentRole; subagentInstanceId?: string; model: string },
): { iteration: number; iterStart: number } {
  counter.start();
  const iteration = counter.count();
  const iterStart = args.trace.now();
  recordIterationStarted({
    trace: args.trace,
    agent: args.agent,
    ...(args.subagentInstanceId !== undefined
      ? { subagentInstanceId: args.subagentInstanceId }
      : {}),
    iteration,
    iterStart,
    model: args.model,
  });
  return { iteration, iterStart };
}

/**
 * Record a `model_call_error` trace event for a failed provider call.
 *
 * @param args.err - the {@link ProviderError}; its `kind`, and (when present)
 *   `status` and `retryAfterMs`, are surfaced on the event, and its message is
 *   passed through {@link sanitizeErrorMessage} before recording.
 * @param args - the remaining fields identify the agent, iteration, and model.
 * @remarks `usage_attributed` reports whether the failed attempts' tokens could
 *   be read and charged. It is recorded only when the error came out of the
 *   retry wrapper (which is what knows), so its absence means "not applicable"
 *   rather than "no".
 */
export function recordModelCallError(args: {
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  model: string;
  err: ProviderError;
}): void {
  const { trace, agent, subagentInstanceId, iteration, model, err } = args;
  trace.record("model_call_error", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration,
    model,
    kind: err.kind,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.retryAfterMs !== undefined ? { retry_after_ms: err.retryAfterMs } : {}),
    ...(err.streamStarted || err.accumulatedUsage !== undefined
      ? { usage_attributed: err.accumulatedUsage !== undefined }
      : {}),
    message: sanitizeErrorMessage(err.message),
  });
}
