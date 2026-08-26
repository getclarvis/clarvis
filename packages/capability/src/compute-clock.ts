import type { Logger } from "./ports.ts";
import { unref } from "./unref.ts";

/**
 * A pausable wall-clock for a run's compute budget: the timeout counts down only
 * while the clock is "running", so time spent blocked on a human (an approval,
 * an elicitation) does not consume it.
 *
 * @remarks The running/paused state is derived from two nested counters — an
 * outer `pause` depth and a set of entered compute regions, of which some may be
 * individually paused. The clock is effectively paused only when there is at
 * least one outstanding `pause` and every active compute region is itself paused;
 * otherwise it is armed and counting down.
 *
 * Background regions ({@link ComputeClock.enterBackground}) are counted apart
 * from that, because they belong to work no dispatch owns: a child running in
 * the background is not covered by its parent's `pauseCompute`, so an unpaused
 * background region keeps the clock armed on its own.
 */
export interface ComputeClock {
  /** Race a loop promise against the timeout; resolves with the loop's value or
   * the literal `"timeout"`. Single-shot — a second call throws. */
  race<T>(loop: Promise<T>): Promise<T | "timeout">;
  /** Add one outstanding pause (may stop the countdown). */
  pause(): void;
  /** Remove one outstanding pause (may resume the countdown); a no-op at zero. */
  resume(): void;
  /** Enter a compute region (an active, non-paused unit of work). */
  enter(): void;
  /** Leave a compute region; a no-op when none are active. */
  leave(): void;
  /** Pause one active compute region and add an outstanding pause, returning an
   * idempotent release that undoes exactly this call. */
  pauseCompute(): () => void;
  /**
   * Enter a background compute region — work that outlives the dispatch which
   * started it, so no `pauseCompute` from another agent may claim it.
   *
   * @returns the region's handle; its owner pauses it while blocked (its own
   *   tool dispatch, an elicitation) and leaves it once when the work settles.
   */
  enterBackground(): ComputeRegion;
  /** Reset the remaining budget back to the full `timeoutMs` and re-arm. */
  poke(): void;
}

/**
 * A background compute region owned by one background child.
 *
 * @remarks While at least one region is live and unpaused the clock counts down,
 * whatever the rest of the tree is doing — the child is spending real tokens. A
 * region is paused by its own owner, so a child blocked on I/O or on a human
 * stops holding the clock armed. Both methods are idempotent per call: `pause`
 * returns a release that undoes exactly itself, and a second `leave` is a no-op.
 */
export interface ComputeRegion {
  /** Pause this region; the returned release resumes it, idempotently. */
  pause(): () => void;
  /** Leave the region for good; its outstanding pauses are dropped with it. */
  leave(): void;
}

/** A bundle of the ambient {@link ComputeClock} and abort {@link AbortSignal} an
 * operation may consult — both optional. */
export interface ClockHolder {
  clock?: ComputeClock;
  signal?: AbortSignal;
}

const MAX_DELAY_MS = 2_147_483_647;

/**
 * Create a {@link ComputeClock} that fires after `timeoutMs` of accumulated
 * running time.
 *
 * @param timeoutMs - the compute budget in milliseconds (clamped to `>= 0`).
 * @param logger - optional logger; used only to debug-log a loop promise that
 *   rejects after {@link ComputeClock.race} has already settled on `"timeout"`.
 * @returns a fresh clock, armed and counting down immediately.
 * @remarks Elapsed time is measured with `performance.now()` and the underlying
 *   timer is unref'd and clamped to `MAX_DELAY_MS`, so it never keeps the
 *   process alive and never overflows.
 */
export function createComputeClock(timeoutMs: number, logger?: Logger): ComputeClock {
  let remaining = Math.max(0, timeoutMs);
  let runningSince: number | undefined;
  let pauseDepth = 0;
  let activeCompute = 0;
  let computePaused = 0;
  let bgActive = 0;
  let bgPaused = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let onFire: (() => void) | undefined;
  let raceConsumed = false;

  const effectivePaused = (): boolean =>
    pauseDepth > 0 && activeCompute <= computePaused && bgActive <= bgPaused;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const stop = (): void => {
    if (runningSince !== undefined) {
      remaining = Math.max(0, remaining - (performance.now() - runningSince));
      runningSince = undefined;
    }
    clearTimer();
  };

  const arm = (): void => {
    if (fired || effectivePaused() || timer !== undefined) return;
    runningSince = performance.now();
    timer = setTimeout(
      () => {
        fired = true;
        timer = undefined;
        runningSince = undefined;
        onFire?.();
      },
      Math.min(remaining, MAX_DELAY_MS),
    );
    unref(timer);
  };

  const sync = (): void => {
    if (fired) return;
    if (effectivePaused()) stop();
    else arm();
  };

  arm();

  return {
    async race<T>(loop: Promise<T>): Promise<T | "timeout"> {
      if (raceConsumed) {
        throw new Error("ComputeClock.race() is single-shot and was already consumed.");
      }
      raceConsumed = true;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        if (fired) {
          resolve("timeout");
          return;
        }
        onFire = () => resolve("timeout");
      });
      try {
        const result = await Promise.race([loop, timeoutPromise]);
        if (result === "timeout") {
          loop.catch((err: unknown) => {
            logger?.debug(
              {
                event: "capability.compute_clock.loop_rejected",
                err: err instanceof Error ? err.message : String(err),
              },
              "compute-clock: loop promise rejected after the race settled",
            );
          });
        }
        return result;
      } finally {
        clearTimer();
        fired = true;
      }
    },
    pause(): void {
      pauseDepth += 1;
      sync();
    },
    resume(): void {
      if (pauseDepth === 0) return;
      pauseDepth -= 1;
      sync();
    },
    enter(): void {
      activeCompute += 1;
      sync();
    },
    leave(): void {
      if (activeCompute === 0) return;
      activeCompute -= 1;
      sync();
    },
    pauseCompute(): () => void {
      pauseDepth += 1;
      const claimed = activeCompute > computePaused;
      if (claimed) computePaused += 1;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pauseDepth -= 1;
        if (claimed) computePaused -= 1;
        sync();
      };
    },
    enterBackground(): ComputeRegion {
      bgActive += 1;
      let depth = 0;
      let left = false;
      sync();
      return {
        pause(): () => void {
          let released = false;
          if (left) return () => {};
          depth += 1;
          if (depth === 1) bgPaused += 1;
          sync();
          return () => {
            if (released || left) return;
            released = true;
            depth -= 1;
            if (depth === 0) bgPaused -= 1;
            sync();
          };
        },
        leave(): void {
          if (left) return;
          left = true;
          bgActive -= 1;
          if (depth > 0) bgPaused -= 1;
          depth = 0;
          sync();
        },
      };
    },
    poke(): void {
      if (fired) return;
      remaining = Math.max(0, timeoutMs);
      clearTimer();
      runningSince = undefined;
      sync();
    },
  };
}
