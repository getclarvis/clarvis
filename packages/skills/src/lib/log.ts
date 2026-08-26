import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

/**
 * A destination for the package's non-fatal warnings — receives the raw message
 * string.
 */
export type WarnSink = (message: string) => void;

/** The default {@link WarnSink}: writes the message verbatim to `process.stderr`. */
export const defaultWarnSink: WarnSink = (message) => {
  process.stderr.write(message);
};

/**
 * Emit a non-fatal warning to the supplied {@link WarnSink}, or stderr.
 *
 * @param message - the warning text, passed through unmodified (no newline added).
 */
export function warn(message: string, sink: WarnSink = defaultWarnSink): void {
  sink(message);
}

/**
 * The two diagnostic destinations every discovery helper writes to: the
 * package's own prose warning sink, and the structured {@link Logger}.
 *
 * @remarks
 * One struct rather than two positional parameters, because the filesystem
 * helpers in `scan.ts` already threaded the sink through seven signatures and a
 * second parameter would have doubled that. It is deliberately shaped so that
 * a resolved `SkillConfig` satisfies it structurally: the config itself is
 * passed wherever diagnostics are wanted, with no per-call allocation.
 *
 * The two are not redundant. The sink carries a formatted sentence a host may
 * surface to a user; the logger carries fields an operator greps. A message is
 * free to change; a field name is a contract.
 */
export interface SkillDiagnostics {
  /** Instance-local destination for non-fatal discovery warnings. */
  warningSink: WarnSink;
  /** Structured destination for this package's diagnostic events. */
  logger: Logger;
}

/** Diagnostics for a caller that supplied none: stderr prose, no structured records. */
export const DEFAULT_DIAGNOSTICS: SkillDiagnostics = {
  warningSink: defaultWarnSink,
  logger: NOOP_LOGGER,
};

/**
 * Reduce an unknown thrown value to a single-line cause string.
 *
 * @param error - the caught value, of any shape.
 * @returns the `Error`'s message, else the value stringified.
 */
export function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Close a file or directory handle, reporting a failure rather than swallowing it.
 *
 * @param close - the close call, invoked once.
 * @param logger - receives one `debug` record when `close` throws.
 * @param fields - identifying fields merged into that record.
 * @remarks The failure is genuinely not actionable by the caller — the read it
 *   belongs to has already produced its value — but a descriptor that will not
 *   close is the shape a leak takes, and an empty `catch` is how it stays
 *   invisible until the process runs out of them.
 */
export function closeQuietly(
  close: () => void,
  logger: Logger,
  fields: Record<string, unknown>,
): void {
  try {
    close();
  } catch (error) {
    logger.debug(
      { event: "skill.handle_close_failed", ...fields, cause: causeOf(error) },
      "a file or directory handle did not close; the read it belongs to already " +
        "completed and the descriptor leaks until the process exits",
    );
  }
}
