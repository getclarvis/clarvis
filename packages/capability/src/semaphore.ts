/**
 * A counting semaphore bounding how many holders run concurrently.
 *
 * @remarks It lives in the contract package because it is pure computation over
 * promises — no node builtin, no filesystem, no engine type — and because two
 * independent fan-out bounds are written against it: the engine's sub-agent
 * limit and the workflow layer's leader limit.
 */
export interface Semaphore {
  /**
   * Resolves once a slot is free — immediately if under the limit, otherwise
   * when a later `release` hands the slot over.
   *
   * @param signal - when given and it aborts while this call is still queued
   *   (not yet granted a slot), the queued waiter is removed and the returned
   *   promise rejects with the signal's abort reason instead of hanging forever
   *   — no slot is granted or leaked to an abandoned waiter. An immediate grant
   *   (already under the limit) always resolves, even with an already-aborted
   *   signal, since no wait ever begins.
   */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Release a slot: wakes the longest-waiting acquirer (FIFO) if any, else
   * lowers the active count. */
  release(): void;
}

/**
 * Create a FIFO counting {@link Semaphore}.
 *
 * @param limit - the maximum concurrent holders; coerced to at least 1 and
 *   floored to an integer.
 * @returns the semaphore.
 * @remarks Each successfully granted `acquire` (one that resolves, including
 *   every immediate grant) must be paired with exactly one `release`; a
 *   `release` with no waiter and no active holder is clamped at zero rather
 *   than going negative. An `acquire` that rejects via an abort signal was
 *   never granted a slot and must NOT be released.
 */
export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(signal?: AbortSignal): Promise<void> {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          if (signal !== undefined) signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const idx = queue.indexOf(grant);
          if (idx === -1) return;
          queue.splice(idx, 1);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        queue.push(grant);
        if (signal === undefined) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    release(): void {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active = Math.max(0, active - 1);
      }
    },
  };
}
