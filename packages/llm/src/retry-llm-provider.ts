import type { Logger } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider, LLMUsage } from "@clarvis/capability";
import { ProviderError } from "@clarvis/capability";
import { unref } from "@clarvis/capability";

/** Sums two token tallies field by field, without mutating either. */
function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
  };
}

/**
 * Retry policy for {@link withTransportRetry}: the attempt cap (`maxRetries`),
 * the exponential-backoff `baseDelayMs` and its `maxDelayMs` ceiling, an optional
 * `maxRetryAfterMs` cap on honoring a server `Retry-After`, and an optional
 * `logger` for retry warnings.
 */
export interface TransportRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs?: number;
  logger?: Logger;
}

/** Why {@link withTransportRetry} stopped retrying a failed call. */
type GaveUpReason =
  "non_transient" | "exhausted" | "stream_started" | "retry_after_too_long" | "aborted";

function isTransient(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.kind === "transient";
}

/**
 * Computes the delay before retry attempt `n`.
 *
 * @param n - the 1-based retry attempt number.
 * @param retryAfterMs - a server-advised delay; when present it wins, capped at
 *   `maxRetryAfterMs`.
 * @param baseDelayMs - the exponential-backoff base.
 * @param maxDelayMs - the backoff ceiling.
 * @param maxRetryAfterMs - the cap applied to a server-advised delay; defaults to
 *   `maxDelayMs`.
 * @returns the delay in milliseconds — either the capped `retryAfterMs`, or
 *   `base * 2^(n-1)` capped at `maxDelayMs` with up to 25% jitter.
 */
export function backoffDelayMs(
  n: number,
  retryAfterMs: number | undefined,
  baseDelayMs: number,
  maxDelayMs: number,
  maxRetryAfterMs: number = maxDelayMs,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxRetryAfterMs);
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (n - 1));
  return Math.min(maxDelayMs, Math.round(exp * (1 + Math.random() * 0.25)));
}

/**
 * Sleeps `ms` milliseconds, resolving early if `signal` aborts.
 *
 * @returns `true` if the sleep was cut short by an abort, `false` if it ran to
 *   completion. The timer is `unref`'d so a pending backoff never keeps the
 *   process alive.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    unref(timer);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps a provider so transient failures are retried with exponential backoff.
 *
 * @param inner - the provider to decorate.
 * @param opts - the retry policy; see {@link TransportRetryOptions}. Per-call
 *   `maxRetries`/`maxRetryAfterMs`/`onRetry` on the params override these.
 * @returns a provider that retries only {@link ProviderError}s of kind
 *   `"transient"`, up to the attempt cap, sleeping {@link backoffDelayMs} between
 *   tries and re-throwing on abort, on a non-transient error, or when a
 *   server-advised `retryAfterMs` exceeds the allowed cap.
 * @remarks A cap of `<= 0` bypasses the wrapper entirely. `onRetry` fires once
 *   per scheduled retry, before the backoff sleep.
 */
export function withTransportRetry(inner: LLMProvider, opts: TransportRetryOptions): LLMProvider {
  const { baseDelayMs, maxDelayMs, logger } = opts;

  return {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      const maxRetries = params.maxRetries ?? opts.maxRetries;
      const maxRetryAfterMs = params.maxRetryAfterMs ?? opts.maxRetryAfterMs ?? maxDelayMs;
      if (maxRetries <= 0) {
        return await inner.call(params).catch((err: unknown) => {
          if (err instanceof ProviderError && err.partialUsage !== undefined) {
            err.accumulatedUsage = err.partialUsage;
          }
          throw err;
        });
      }
      let attempt = 0;
      let lost: LLMUsage | undefined;
      /**
       * Closes the story the retry `warn` opens.
       *
       * @remarks Every `warn` above says a retry is coming; without this, the
       *   last one is followed by nothing at all and an operator cannot tell an
       *   exhausted budget from a failure that was never retryable. `debug`
       *   rather than `warn` because the failure itself already reaches the
       *   user through `model_call_error` — what is missing is only *why the
       *   retrying stopped*.
       */
      const gaveUp = (err: unknown, reason: GaveUpReason): void => {
        const provided = err instanceof ProviderError ? err : undefined;
        logger?.debug(
          {
            event: "llm.retry.gave_up",
            provider: params.provider,
            model: params.model,
            attempt,
            max_retries: maxRetries,
            kind: provided?.kind,
            status: provided?.status,
            reason,
            lost_input_tokens: lost?.input_tokens ?? 0,
            lost_output_tokens: lost?.output_tokens ?? 0,
          },
          "the retry budget stopped here; the failure is handed to the run as-is",
        );
      };
      const chargeLost = (err: ProviderError): void => {
        if (err.partialUsage === undefined) return;
        lost = lost === undefined ? { ...err.partialUsage } : addUsage(lost, err.partialUsage);
      };
      const withLost = <T extends { retriedUsage?: LLMUsage }>(value: T): T =>
        lost === undefined ? value : { ...value, retriedUsage: lost };

      for (;;) {
        try {
          const result = await inner.call(params);
          return withLost(result);
        } catch (err) {
          /**
           * Charged for every {@link ProviderError}, not only retryable ones: a
           * first-attempt `auth` or `quota` failure still billed whatever it
           * read, and skipping it would make `usage_attributed` report `false`
           * for tokens that were in fact readable — the one distinction that
           * field exists to draw.
           */
          if (err instanceof ProviderError) chargeLost(err);
          if (!isTransient(err) || attempt >= maxRetries || params.signal?.aborted === true) {
            gaveUp(
              err,
              !isTransient(err) ? "non_transient" : attempt >= maxRetries ? "exhausted" : "aborted",
            );
            if (err instanceof ProviderError && lost !== undefined) err.accumulatedUsage = lost;
            throw err;
          }
          /**
           * Once a delta has reached the consumer the prompt has been billed in
           * full, and a retry re-sends and re-bills all of it — at a large
           * context, the dominant cost of the turn. The truncated turn that
           * results is handled by the loop as an ordinary model-call error.
           */
          const streamedToConsumer =
            err.streamStarted &&
            (params.onStreamDelta !== undefined || params.onToolInputDelta !== undefined);
          if (streamedToConsumer) {
            gaveUp(err, "stream_started");
            err.accumulatedUsage = lost;
            throw err;
          }
          if (err.retryAfterMs !== undefined && err.retryAfterMs > maxRetryAfterMs) {
            gaveUp(err, "retry_after_too_long");
            err.accumulatedUsage = lost;
            throw err;
          }
          attempt += 1;
          const delay = backoffDelayMs(
            attempt,
            err.retryAfterMs,
            baseDelayMs,
            maxDelayMs,
            maxRetryAfterMs,
          );
          params.onRetry?.({
            attempt,
            maxRetries,
            delayMs: delay,
            kind: err.kind,
            ...(err.status !== undefined ? { status: err.status } : {}),
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          });
          logger?.warn(
            {
              event: "llm.retry.scheduled",
              provider: params.provider,
              model: params.model,
              attempt,
              max_retries: maxRetries,
              delay_ms: delay,
              status: err.status,
            },
            "llm.call transient failure — retrying",
          );
          const aborted = await cancellableSleep(delay, params.signal);
          if (aborted) {
            gaveUp(err, "aborted");
            err.accumulatedUsage = lost;
            throw err;
          }
        }
      }
    },
  };
}
