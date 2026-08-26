import type { Logger } from "@clarvis/capability";

/**
 * The one-method sink `TaskObservation` accepts.
 *
 * @remarks Structural rather than the whole {@link Logger}, because
 * `@clarvis/capability` deliberately declares only `warn` there: a best-effort
 * observer has one severity.
 */
export interface ObservationSink {
  warn(fields: object, message: string): void;
}

/**
 * Wrap a logger so a detached operation's failure carries a stable event name.
 *
 * @param logger - the component's logger.
 * @param event - the event name every record from this sink carries.
 * @returns an {@link ObservationSink} to pass as `detachObserved`'s `logger`.
 * @remarks Every call site that uses this previously passed an `observer` that
 * called `process.emitWarning`. No package installs a `process.on("warning")`
 * handler, so those records reached the host's raw stderr — over the terminal a
 * TUI owns, and interleaved as non-JSON lines with pino JSON in a container.
 * They are diagnostics about Clarvis's own machinery and belong on the logger
 * like every other one.
 *
 * The prose comes from `bestEffort`, which already composes a sentence from the
 * operation; only the machine-readable name is added here.
 */
export function observationSink(logger: Logger, event: string): ObservationSink {
  return {
    warn(fields: object): void {
      logger.warn(
        { ...fields, event },
        "a detached kernel operation failed; nothing retries it, and whatever it was releasing may still be held",
      );
    },
  };
}
