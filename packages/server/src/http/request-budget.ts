import { scheduleSystemTimeout, type ScheduleTimeout } from "../timing.ts";

/** Why an HTTP initialization request stopped before its work settled. */
export interface RequestInterruption {
  readonly code: "cancelled" | "unavailable";
  readonly message: string;
  readonly status: 408 | 503;
}

/** The three terminal outcomes of work observed through a request budget. */
export type RequestWorkOutcome<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected"; readonly reason: unknown }
  | { readonly state: "interrupted"; readonly interruption: RequestInterruption };

/** One abort/deadline budget shared by every phase of session initialization. */
export interface RequestBudget {
  /** Observe work without leaving a losing rejection unhandled. */
  race<T>(work: PromiseLike<T>): Promise<RequestWorkOutcome<T>>;
  /** Remove the request listener and cancel a deadline that did not fire. */
  dispose(): void;
  readonly interruption: RequestInterruption | undefined;
}

/**
 * Bind session initialization to its request lifetime and one overall deadline.
 *
 * @remarks The underlying work is not assumed to support cancellation. A losing
 * promise remains rejection-observed, while its resource-specific late cleanup
 * stays with the caller that owns that promise.
 */
export function createRequestBudget(options: {
  signal: AbortSignal;
  timeoutMs: number;
  scheduleTimeout?: ScheduleTimeout;
}): RequestBudget {
  let interruption: RequestInterruption | undefined;
  let resolveInterruption!: (outcome: RequestWorkOutcome<never>) => void;
  const interrupted = new Promise<RequestWorkOutcome<never>>((resolve) => {
    resolveInterruption = resolve;
  });

  const interrupt = (next: RequestInterruption): void => {
    if (interruption !== undefined) return;
    interruption = next;
    resolveInterruption({ state: "interrupted", interruption: next });
  };
  const onAbort = (): void => {
    interrupt({
      code: "cancelled",
      message: "session initialization request was cancelled",
      status: 408,
    });
  };

  options.signal.addEventListener("abort", onAbort, { once: true });
  const cancelTimeout = (options.scheduleTimeout ?? scheduleSystemTimeout)(
    () =>
      interrupt({
        code: "unavailable",
        message: `session initialization timed out after ${String(options.timeoutMs)}ms`,
        status: 503,
      }),
    options.timeoutMs,
  );
  if (options.signal.aborted) onAbort();

  let disposed = false;
  return {
    race<T>(work: PromiseLike<T>): Promise<RequestWorkOutcome<T>> {
      const observed = Promise.resolve(work).then<RequestWorkOutcome<T>, RequestWorkOutcome<T>>(
        (value) => ({ state: "fulfilled", value }),
        (reason: unknown) => ({ state: "rejected", reason }),
      );
      return Promise.race([observed, interrupted]);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      options.signal.removeEventListener("abort", onAbort);
      cancelTimeout();
    },
    get interruption(): RequestInterruption | undefined {
      return interruption;
    },
  };
}
