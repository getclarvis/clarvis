import { diagnosticEvent } from "./diagnostic-events.ts";

/**
 * Detach UI work while retaining an observable failure path.
 *
 * @param operation - the stable name this work is recorded under.
 * @param run - the work; a synchronous throw and a rejected promise are treated
 *   alike.
 * @param observer - the local error channel, when the caller has one.
 * @remarks Every failure is recorded through {@link diagnosticEvent} *before*
 *   the local observer runs, so the record does not depend on the observer
 *   existing or succeeding.
 *
 *   It deliberately writes nowhere else. This used to fall back to
 *   `process.emitWarning` when no observer was supplied, and no package installs
 *   a `process.on("warning")` handler — so Bun's default handler wrote a
 *   multi-line warning to stderr while the renderer owned the terminal. Most of
 *   this package's detached call sites pass no observer, which made an ordinary
 *   background failure paint over the canvas and read as a rendering bug. The
 *   record above already carried the same fact somewhere safe.
 */
export function detachObserved(
  operation: string,
  run: () => unknown,
  observer?: (error: unknown) => void,
): void {
  const observe = (error: unknown): void => {
    diagnosticEvent("task.failed", { operation, error, observed: observer !== undefined }, "error");
    if (observer === undefined) return;
    try {
      observer(error);
    } catch (observerError) {
      diagnosticEvent("task.observer_failed", { operation, error: observerError }, "error");
    }
  };

  let result: unknown;
  try {
    result = run();
  } catch (error) {
    observe(error);
    return;
  }
  void Promise.resolve(result).catch(observe);
}
