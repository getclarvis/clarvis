import { warn } from "./log.ts";

/**
 * Observe cleanup work that may fail without rejecting its caller.
 *
 * @param operation - the stable name the failure is recorded under.
 * @param run - the work.
 * @remarks Routes through the package's own {@link warn} sink rather than
 *   `process.emitWarning`, which was the last remaining call of its kind in the
 *   repository. No package installs a `process.on("warning")` handler, so that
 *   call reached the host's raw stderr — painting over the terminal UI's frame —
 *   and, in a container, interleaved a non-JSON line with the host's JSON log.
 *   The sink is the host's to install; until it does, the package default
 *   writes the message to `stderr`.
 *
 *   The message carries no cause: the operations reaching here are cleanup, the
 *   operand is a workspace path, and the failure is already implied by whatever
 *   the caller reports. Keeping it to a name and an event is what lets this stay
 *   free of a dependency edge from `tools` to `capability`.
 */
export async function bestEffort(operation: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch {
    warn(`best-effort operation failed (${operation})\n`, {
      event: "tools.best_effort_failed",
      level: "debug",
      fields: { operation },
    });
  }
}
