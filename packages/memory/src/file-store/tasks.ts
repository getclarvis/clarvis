import { bestEffort, detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";

/**
 * The observation one file-store side effect reports its failure through.
 *
 * @param operation - the stable name of the work that failed.
 * @param logger - where the failure is reported.
 * @returns the observation `bestEffort` and `detachObserved` take.
 * @remarks These used to route to `process.emitWarning`, which bypasses every
 * logger: no package installs a `process.on("warning")` handler, so Bun's
 * default handler wrote the line straight to the host's stderr — over the TUI's
 * own canvas, and as a non-JSON line interleaved into a container's JSON log.
 * Lock cleanup, the stale-lock steal, lock release and the heartbeat all pass
 * through here, so this one seam is the whole of the file store's warning
 * channel.
 */
const observe = (operation: string, logger: Logger) => ({ operation, logger });

/** Run a file-store side effect whose failure must not reject its caller. */
export function bestEffortFileStore(
  operation: string,
  run: () => unknown,
  logger: Logger = NOOP_LOGGER,
): Promise<void> {
  return bestEffort(run, observe(operation, logger));
}

/** Detach a file-store side effect, retaining an observable failure path. */
export function detachFileStoreTask(
  operation: string,
  run: () => unknown,
  logger: Logger = NOOP_LOGGER,
): void {
  detachObserved(run, observe(operation, logger));
}
