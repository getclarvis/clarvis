import type { ErrorCode } from "./run.ts";

/**
 * Base class for loop errors that carry a stable machine-readable `code` and an
 * optional structured `details` bag alongside the human-readable message.
 *
 * @remarks Subclasses supply the `code`; `name` is set from the concrete
 *   constructor (`new.target.name`) so each error reports its own class name.
 */
export abstract class CodedError extends Error {
  /** Stable machine-readable discriminator supplied by the concrete subclass. */
  abstract readonly code: string;
  /** Optional structured context attached to the error, omitted when absent. */
  readonly details?: Record<string, unknown>;
  /**
   * @param message - the human-readable error message.
   * @param details - optional structured context; only stored when defined.
   */
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
  }
}

/**
 * A request/input validation failure, carrying a caller-supplied
 * {@link ErrorCode} so the specific validation rule is machine-identifiable.
 */
export class ValidationError extends CodedError {
  /** The specific validation {@link ErrorCode} for this failure. */
  readonly code: ErrorCode;
  /**
   * @param code - the validation error code to report.
   * @param message - the human-readable error message.
   * @param details - optional structured context.
   */
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/** A mandatory host capability failed setup; continuing without its controls is forbidden. */
export class CapabilityUnavailableError extends CodedError {
  readonly code = "required_capability_unavailable" as const;
  constructor(capability: string, phase: "activation" | "seed" | "entry") {
    super(`Required capability '${capability}' is unavailable during ${phase}`, {
      capability,
      phase,
    });
  }
}

/**
 * Raised when an execution id already exists for a given key; `code` is fixed to
 * `"execution_id_conflict"`. See {@link executionIdConflict} for the standard
 * factory.
 */
export class ConflictError extends CodedError {
  /** Fixed discriminator, `"execution_id_conflict"`. */
  readonly code = "execution_id_conflict" as const;
  /**
   * @param message - the human-readable error message.
   * @param details - optional structured context.
   */
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Raised when persisting an execution fails; `code` is fixed to
 * `"persistence_failure"`.
 */
export class PersistenceError extends CodedError {
  /** Fixed discriminator, `"persistence_failure"`. */
  readonly code = "persistence_failure" as const;
  /**
   * @param message - the error message (defaults to `"Failed to persist execution."`).
   * @param details - optional structured context.
   */
  constructor(message = "Failed to persist execution.", details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Raised when a `continue_from` id has no stored context to resume against —
 * an unknown id, a pruned trace, or a run that ended before any context
 * existed; `code` is fixed to `"continuation_unavailable"`. The message directs
 * the caller to retry with the full message history instead.
 */
export class ContinuationUnavailableError extends CodedError {
  /** Fixed discriminator, `"continuation_unavailable"`. */
  readonly code = "continuation_unavailable" as const;
  /** @param continueFrom - the unresolvable continuation id, echoed into `details.continue_from`. */
  constructor(continueFrom: string) {
    super(
      `continue_from '${continueFrom}' has no stored context for this owner (unknown id, pruned ` +
        "trace, or a run that ended before any context existed). Retry with the full message " +
        "history instead.",
      { continue_from: continueFrom },
    );
  }
}

/**
 * Build the standard {@link ConflictError} for a duplicate execution id.
 *
 * @param id - the conflicting execution id, echoed into `details.execution_id`.
 * @returns a {@link ConflictError} with a message naming the id.
 */
export function executionIdConflict(id: string): ConflictError {
  return new ConflictError(`execution_id '${id}' already exists for this key.`, {
    execution_id: id,
  });
}
