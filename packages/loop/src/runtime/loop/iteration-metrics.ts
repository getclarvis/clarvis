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
   * @returns `true` for a newly observed cache drop or cached-token stagnation
   *   during sufficient input growth after the initial warming observations.
   */
  observe(cachedTokens: number, inputTokens?: number): boolean;
  resetForCompaction(): void;
  diagnostics(): {
    reason?: "drop" | "stagnation";
    observations: number;
    base: number;
    input_growth?: number;
    cached_growth?: number;
  };
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

/** Observe cache loss and a flat cached-token series during measured context growth. */
export function createCachePrefixWatch(): CachePrefixWatch {
  let previous: number | undefined;
  let reported = false;
  let stagnationReported = false;
  let observations = 0;
  let base = 0;
  let reason: "drop" | "stagnation" | undefined;
  const window: Array<{ input: number; cached: number }> = [];
  let inputGrowth: number | undefined;
  let cachedGrowth: number | undefined;
  return {
    resetForCompaction(): void {
      previous = undefined;
      reported = false;
      stagnationReported = false;
      observations = 0;
      window.length = 0;
      inputGrowth = undefined;
      cachedGrowth = undefined;
      reason = undefined;
      base += 1;
    },
    diagnostics: () => ({
      reason,
      observations,
      base,
      input_growth: inputGrowth,
      cached_growth: cachedGrowth,
    }),
    observe(cachedTokens: number, inputTokens?: number): boolean {
      if (
        !Number.isFinite(cachedTokens) ||
        cachedTokens < 0 ||
        (inputTokens !== undefined && (!Number.isFinite(inputTokens) || inputTokens < cachedTokens))
      )
        return false;
      observations += 1;
      const prior = previous;
      previous = cachedTokens;
      const lost =
        prior !== undefined && prior > 0 && cachedTokens < prior * (1 - CACHE_PREFIX_LOSS);
      let stagnant = false;
      if (inputTokens !== undefined && observations > 2) {
        window.push({ input: inputTokens, cached: cachedTokens });
        if (window.length > 10) window.shift();
        const first = window[0]!;
        inputGrowth = inputTokens - first.input;
        cachedGrowth = cachedTokens - first.cached;
        stagnant =
          window.length >= 10 &&
          (inputGrowth >= 8000 || inputGrowth >= first.input * 0.25) &&
          cachedGrowth < inputGrowth * 0.1;
      }
      reason = stagnant ? "stagnation" : lost ? "drop" : undefined;
      const notify = (lost && !reported) || (stagnant && !stagnationReported);
      reported = lost;
      stagnationReported = stagnant;
      return notify;
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
  const lost =
    args.llmResult.cacheUsageKnown !== false &&
    args.cacheWatch?.observe(
      args.llmResult.usage.cached_tokens,
      args.llmResult.usage.input_tokens,
    ) === true;
  if (!lost && !levelEnabled(logger, "debug")) return;
  const fields = {
    event: "iteration.cache",
    ...args.cacheWatch?.diagnostics(),
    iteration: args.iteration,
    input_tokens: args.llmResult.usage.input_tokens,
    cached_tokens: args.llmResult.usage.cached_tokens,
    ratio,
    usage_known: args.llmResult.cacheUsageKnown !== false,
    prefix_divergence: args.llmResult.requestPrefix?.divergence?.surface,
    prefix_divergence_item: args.llmResult.requestPrefix?.divergence?.item,
  };
  if (lost) {
    logger.warn(
      fields,
      "provider cache reuse dropped or stagnated while input grew; inspect serialized request evidence",
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
