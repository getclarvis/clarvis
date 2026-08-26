import { detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";

let sink: Logger = NOOP_LOGGER;

/**
 * Point every detached server task at the host's logger.
 *
 * @param logger - the diagnostic channel the boot composed.
 * @remarks Installed once, at boot. A module-level sink is what keeps the eleven
 * call sites free of a logger they would each have to be handed — the design
 * intent this module has always had, now with a destination instead of
 * `process.emitWarning`, which no package installs a handler for and which
 * therefore wrote to a terminal a renderer might own.
 */
export function setServerTaskObserver(logger: Logger): void {
  sink = logger;
}

/** Report one detached task's failure. */
function reportTaskFailure(operation: string, cause: string): void {
  sink.warn(
    { event: "task.failed", operation, err: cause },
    "a detached server task failed; whatever request it belonged to has already been answered",
  );
}

/** Observe a server background task without coupling transport modules to a logger instance. */
export function observeServerTask(operation: string, run: () => unknown): void {
  detachObserved(run, {
    operation,
    observer: ({ cause }) => reportTaskFailure(operation, cause),
  });
}
