import { suppressSecondaryRejection, unref } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { ResolvedConfig, RunResponse, Usage } from "@clarvis/capability";
import { createComputeClock, type ClockHolder, type ComputeClock } from "@clarvis/capability";
import { combineSignals } from "./support/signals.ts";
import { errorResponse } from "./support/run-response.ts";
import { mapErrorToResponse } from "./run-response-mapping.ts";

/**
 * After a timeout abort, wait up to `graceMs` for the loop promise to settle.
 *
 * @param loop - the in-flight loop promise being wound down.
 * @param graceMs - the grace window; the timer is `unref`ed so it never keeps
 *   the process alive.
 * @returns `true` if the loop settled within the grace, `false` if the grace
 *   elapsed first (the loop did not unwind in time).
 */
async function settleAfterAbort(loop: Promise<unknown>, graceMs: number): Promise<boolean> {
  let settled = false;
  const onSettle = (): void => {
    settled = true;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      loop.then(onSettle, onSettle),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        unref(timer);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return settled;
}

/**
 * Run the loop under a stall-based {@link ComputeClock} and turn its outcome —
 * completion, inactivity timeout, or thrown error — into a {@link RunResponse}.
 *
 * A fresh clock (armed with `config.timeout_ms`) races the loop; the loop's
 * signal combines the caller's `externalSignal` with an internal timeout
 * controller. The clock measures inactivity, not wall time: it is poked on every
 * trace entry (see {@link traceBridge}), so `timeout_ms` means "no activity for
 * this long", flagged as a possible wedge.
 *
 * @param opts.config - resolved config supplying `timeout_ms`.
 * @param opts.settleGraceMs - how long to let the loop unwind after a timeout or
 *   caller cancellation before releasing the outer run. A non-cooperative
 *   handler is detached after the grace so it cannot pin persistence and host
 *   lifecycle finalizers forever; its eventual rejection remains observed.
 * @param opts.externalSignal - the caller's cancel signal, combined with the
 *   internal timeout signal and also passed to the error mapper for
 *   cancellation classification.
 * @param opts.startedAt - `performance.now()` origin used to report `elapsed_ms`.
 * @param opts.clockHolder - receives the live `clock` and combined `signal` so
 *   other subsystems can observe them.
 * @param opts.finalize - snapshots usage; called exactly once on every exit path.
 * @param opts.buildLoop - starts the loop given the clock and combined signal.
 * @param opts.toResponse - maps a successful loop result plus final usage to the
 *   response.
 * @returns the completion response, a `timeout` {@link errorResponse}, or the
 *   error-mapped response from a thrown loop.
 */
export async function runWithClockAndTimeout<T>(opts: {
  config: ResolvedConfig;
  settleGraceMs: number;
  logger?: Logger;
  externalSignal?: AbortSignal;
  startedAt: number;
  clockHolder: ClockHolder;
  finalize: () => Usage;
  buildLoop: (ctx: { clock: ComputeClock; signal: AbortSignal | undefined }) => Promise<T>;
  toResponse: (loopResult: T, usage: Usage) => RunResponse;
}): Promise<RunResponse> {
  const { config, settleGraceMs, logger, externalSignal, startedAt, clockHolder, finalize } = opts;
  const clock = createComputeClock(config.timeout_ms, logger);
  clockHolder.clock = clock;
  const timeoutController = new AbortController();
  const effectiveSignal = combineSignals(externalSignal, timeoutController.signal);
  clockHolder.signal = effectiveSignal;
  const externallyAborted = Symbol("externally-aborted");
  let removeAbortListener: (() => void) | undefined;
  try {
    const loopPromise = opts.buildLoop({ clock, signal: effectiveSignal });
    const observedLoop: Promise<T | typeof externallyAborted> =
      externalSignal === undefined
        ? loopPromise
        : Promise.race<T | typeof externallyAborted>([
            loopPromise,
            new Promise<typeof externallyAborted>((resolve) => {
              const onAbort = (): void => resolve(externallyAborted);
              if (externalSignal.aborted) {
                onAbort();
                return;
              }
              externalSignal.addEventListener("abort", onAbort, { once: true });
              removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
            }),
          ]);
    const winner = await clock.race(observedLoop);
    if (winner === "timeout") {
      timeoutController.abort();
      const settled = await settleAfterAbort(loopPromise, settleGraceMs);
      if (!settled) {
        logger?.warn(
          {
            event: "run.teardown_detached",
            outcome: "timeout",
            grace_ms: settleGraceMs,
            elapsed_ms: Math.round(performance.now() - startedAt),
          },
          "run timed out and the loop did not settle within the grace; detaching non-cooperative teardown",
        );
        suppressSecondaryRejection(
          loopPromise,
          "the run timeout race and detached teardown warning",
        );
      }
      return errorResponse(
        finalize(),
        "timeout",
        `Run stalled: no activity for timeout_ms=${config.timeout_ms} (possible wedge).`,
        {
          elapsed_ms: Math.round(performance.now() - startedAt),
        },
      );
    }
    if (winner === externallyAborted) {
      const settled = await settleAfterAbort(loopPromise, settleGraceMs);
      if (!settled) {
        logger?.warn(
          {
            event: "run.teardown_detached",
            outcome: "cancelled",
            grace_ms: settleGraceMs,
            elapsed_ms: Math.round(performance.now() - startedAt),
          },
          "run cancellation did not settle within the grace; detaching non-cooperative teardown",
        );
        suppressSecondaryRejection(
          loopPromise,
          "the run cancellation race and detached teardown warning",
        );
      }
      return mapErrorToResponse(externalSignal?.reason, finalize(), externalSignal);
    }
    return opts.toResponse(winner, finalize());
  } catch (err) {
    return mapErrorToResponse(err, finalize(), externalSignal);
  } finally {
    removeAbortListener?.();
  }
}
