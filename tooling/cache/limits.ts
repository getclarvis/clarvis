import { validCacheUsage } from "./evaluation.ts";
import type { CacheCall, CacheLimits } from "./types.ts";

/** Hard physical-attempt ledger. Limits never expand in response to quota, retries or incomplete work. */
export class CacheBudget {
  readonly startedAt: number;
  readonly calls: CacheCall[] = [];
  private startedCalls = 0;
  private input = 0;
  private output = 0;
  private readonly cancellation = new AbortController();
  readonly signal: AbortSignal;

  constructor(
    readonly limits: CacheLimits,
    previous: readonly CacheCall[] = [],
    startedAt = Date.now(),
  ) {
    this.startedAt = startedAt;
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError("cache limits must be positive safe integers");
    this.signal = AbortSignal.any([
      this.cancellation.signal,
      AbortSignal.timeout(Math.max(1, limits.durationMs - (Date.now() - startedAt))),
    ]);
    this.startedCalls = previous.length;
    for (const call of previous) this.record(call);
  }

  admit(): void {
    this.check();
    this.startedCalls += 1;
  }

  check(): void {
    if (this.exhausted()) throw new Error("cache_qualification_limit_reached");
  }

  record(call: CacheCall): void {
    this.calls.push(call);
    if (validCacheUsage(call.usage)) {
      this.input += call.usage.input;
      this.output += call.usage.output;
      if (this.input >= this.limits.input || this.output >= this.limits.output)
        this.cancellation.abort(new Error("cache_token_limit_reached"));
    }
  }

  /** Recover already-issued worker calls exactly once, even when their execution exhausted a cap. */
  reconcile(calls: readonly CacheCall[]): void {
    for (const call of calls) {
      if (
        this.calls.some(
          (known) =>
            known.sessionId === call.sessionId &&
            known.agentInstanceId === call.agentInstanceId &&
            known.startedAt === call.startedAt &&
            known.iteration === call.iteration &&
            known.attempt === call.attempt,
        )
      )
        continue;
      this.startedCalls += 1;
      this.record(call);
    }
  }

  exhausted(): boolean {
    return (
      this.startedCalls >= this.limits.calls ||
      this.input >= this.limits.input ||
      this.output >= this.limits.output ||
      Date.now() - this.startedAt >= this.limits.durationMs
    );
  }
}
