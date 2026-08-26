import { unref } from "@clarvis/capability";

/** The largest delay a `setTimeout` accepts (2^31 - 1 ms); longer waits are
 * clamped to this so the timer fires rather than overflowing to immediate. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How {@link boundPromise} resolves each way it can settle.
 *
 * @remarks Every branch produces a value of `T` — there is no rejection path
 * except through `mapRejection`'s own `throw`. `onTimeout`/`onAbort` supply the
 * fallback value; `mapRejection`, when given, converts an underlying rejection
 * into a value instead of letting it propagate.
 */
export interface BoundPromiseOptions<T> {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onTimeout: () => T;
  onAbort: () => T;
  mapRejection?: (err: unknown) => T;
}

/**
 * Race a promise against an optional timeout and abort signal, resolving with a
 * caller-supplied value on whichever fires first.
 *
 * @param run - factory for the promise being bounded (invoked immediately).
 * @param opts - timeout, signal, and the settle handlers; see
 *   {@link BoundPromiseOptions}.
 * @returns the run's value if it settles first; otherwise `onAbort()` (signal)
 *   or `onTimeout()` (timeout). Only the first of these wins — later settlements
 *   are ignored.
 * @remarks An already-aborted signal resolves via `onAbort` before `run` can
 *   win. The timeout is clamped to {@link MAX_TIMER_DELAY_MS} and its timer is
 *   unref'd so it never keeps the process alive. A rejection from `run` is
 *   passed to `mapRejection` if provided, else rethrown (wrapped as an `Error`).
 */
export function boundPromise<T>(run: () => Promise<T>, opts: BoundPromiseOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => T): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        resolve(finish());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const onAbort = (): void => settle(opts.onAbort);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () => settle(opts.onTimeout),
        Math.min(opts.timeoutMs, MAX_TIMER_DELAY_MS),
      );
      unref(timer);
    }
    run().then(
      (value) => settle(() => value),
      (err: unknown) =>
        settle(() => {
          if (opts.mapRejection) return opts.mapRejection(err);
          throw err instanceof Error ? err : new Error(String(err));
        }),
    );
  });
}
