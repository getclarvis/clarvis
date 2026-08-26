/**
 * Time and scheduling, as an injected port.
 *
 * The index worker waits — between drains, and for a job's backoff to
 * elapse. Real waiting makes tests slow and flaky, so the worker never calls
 * `setTimeout` directly: it asks a {@link MemoryClock}, and a test supplies one
 * whose time only moves when the test moves it.
 */

/** The time and timer facilities the worker needs. */
export interface MemoryClock {
  /** Current epoch milliseconds. */
  now(): number;
  /**
   * Run `fn` after `ms` have elapsed.
   *
   * @param ms - the delay.
   * @param fn - the callback.
   * @returns a canceller; calling it prevents `fn` from running.
   * @remarks An implementation backed by real timers **must** unref them, so a
   *   pending drain never keeps a process alive on its own.
   */
  after(ms: number, fn: () => void): () => void;
}

/**
 * The production clock: real time, real timers, unref'd.
 *
 * @remarks `unref` is applied defensively — the property is absent on some
 * runtimes' timer objects, and a missing unref would silently hold the process
 * open after the host asked it to exit.
 */
export const systemClock: MemoryClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return () => {
      clearTimeout(timer);
    };
  },
};
