import {
  ProviderError,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type OutputTokenBudget,
} from "@clarvis/capability";

/** Raised before a provider call when its shared output budget has no headroom. */
export class OutputBudgetExhaustedError extends Error {
  constructor() {
    super("the shared output-token budget is exhausted");
    this.name = "OutputBudgetExhaustedError";
  }
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(value));
}

function outputUsed(result: LLMCallResult): number {
  return (
    Math.max(0, result.usage.output_tokens) + Math.max(0, result.retriedUsage?.output_tokens ?? 0)
  );
}

/**
 * Whether the call provably generated no billable output.
 *
 * @remarks `streamStarted` is the evidence, and it is real evidence rather than
 * a guess: the adapter derives it from whether any delta reached the consumer
 * (`outputObserved || batcher.emitted()`), and attaches it to every
 * {@link ProviderError} it raises. A failure that never started streaming, and
 * that carries neither accumulated nor partial usage, cannot have produced
 * output for anyone to bill — a rate limit, a connection that never opened, a
 * request the provider rejected on shape.
 *
 * This replaces an enumeration (`context_overflow`, or `client` with a forced
 * tool choice) that named two rejections out of the many that generate nothing.
 * Everything it did not name fell through to charging the **whole** reservation,
 * and the reservation covers every configured attempt of a call bounded only by
 * the shared ceiling — so on a workflow tree one HTTP 429 charged the entire
 * `workflows.budget_tokens` in a single call. Measured: two consecutive runs
 * whose real output was 2,925 and 12,231 tokens both recorded `totals.output`
 * of exactly 262,144, the ceiling, and every agent spawned afterwards died at
 * its pre-iteration budget check.
 */
function producedNoBillableOutput(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    !error.streamStarted &&
    error.accumulatedUsage === undefined &&
    error.partialUsage === undefined
  );
}

/**
 * Guard every call through `llm` with a real output-token reservation.
 *
 * @remarks A transport retry is another potentially billable completion, so
 * the reservation covers every configured attempt and the per-attempt provider
 * cap is reduced when the remaining tree budget cannot cover all of them. With
 * a bounded budget `maxRetries` is always sent explicitly; otherwise an inner
 * retry decorator could apply an unseen default and escape the reservation.
 */
export function withOutputTokenBudget(llm: LLMProvider, budget: OutputTokenBudget): LLMProvider {
  return {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      const remaining = budget.remaining();
      if (remaining === Number.POSITIVE_INFINITY) {
        try {
          const result = await llm.call(params);
          const used = outputUsed(result);
          if (used > 0) budget.reserveOutput(used)?.settle(used);
          return result;
        } catch (err) {
          const used =
            err instanceof ProviderError &&
            (err.accumulatedUsage !== undefined || err.partialUsage !== undefined)
              ? Math.max(0, (err.accumulatedUsage ?? err.partialUsage)?.output_tokens ?? 0)
              : 0;
          if (used > 0) budget.reserveOutput(used)?.settle(used);
          throw err;
        }
      }
      if (remaining < 1) throw new OutputBudgetExhaustedError();

      const configuredAttempts = positiveInteger((params.maxRetries ?? 0) + 1);
      const desiredPerAttempt = positiveInteger(params.maxOutputTokens ?? remaining);
      const requested = Math.min(
        positiveInteger(remaining),
        Number.MAX_SAFE_INTEGER,
        desiredPerAttempt * configuredAttempts,
      );
      const reservation = budget.reserveOutput(requested);
      if (reservation === null || reservation.amount < 1) {
        reservation?.release();
        throw new OutputBudgetExhaustedError();
      }

      const attempts = Math.max(1, Math.min(configuredAttempts, Math.floor(reservation.amount)));
      const perAttempt = Math.max(
        1,
        Math.min(desiredPerAttempt, Math.floor(reservation.amount / attempts)),
      );
      const bounded: LLMCallParams = {
        ...params,
        maxOutputTokens: perAttempt,
        maxRetries: attempts - 1,
      };

      try {
        const result = await llm.call(bounded);
        reservation.settle(outputUsed(result));
        return result;
      } catch (err) {
        if (
          err instanceof ProviderError &&
          (err.accumulatedUsage !== undefined || err.partialUsage !== undefined)
        ) {
          reservation.settle(
            Math.max(0, (err.accumulatedUsage ?? err.partialUsage)?.output_tokens ?? 0),
          );
        } else if (producedNoBillableOutput(err)) {
          reservation.release();
        } else {
          // Output had begun streaming (or the failure is not one the provider
          // layer classified at all) and no accounting survived it. That is the
          // genuinely uncertain case, and charging the full reservation is the
          // only way to keep the shared ceiling hard.
          reservation.settle(reservation.amount);
        }
        throw err;
      }
    },
  };
}
