import type { KernelError, KernelErrorCode } from "@clarvis/protocol";

/**
 * Typed kernel failure carrying a protocol {@link KernelErrorCode} and optional details.
 */
export class KernelException extends Error implements KernelError {
  /** Machine-readable protocol error code clients discriminate on. */
  readonly code: KernelErrorCode;
  /** Optional structured payload carrying error-specific context. */
  readonly details?: unknown;
  /**
   * @param code - the protocol {@link KernelErrorCode}.
   * @param message - human-readable failure message.
   * @param details - optional structured context.
   */
  constructor(code: KernelErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "KernelException";
    this.code = code;
    this.details = details;
  }
}

/**
 * Convenience factory for {@link KernelException}.
 *
 * @param code - the protocol {@link KernelErrorCode}.
 * @param message - human-readable failure message.
 * @param details - optional structured context.
 * @returns the constructed exception (not thrown).
 */
export function kernelError(
  code: KernelErrorCode,
  message: string,
  details?: unknown,
): KernelException {
  return new KernelException(code, message, details);
}

/**
 * Normalizes any thrown value into a {@link KernelException} so failures cross the
 * kernel boundary with a stable protocol code.
 *
 * @param err - the caught value (an `Error`, a code-bearing object, or anything).
 * @returns the value unchanged if already a {@link KernelException}, otherwise a
 *   fresh one.
 * @remarks An own `code` of `continuation_unavailable` is preserved; an error
 *   whose `name` contains `Validation` maps to `invalid_request` and `Conflict`
 *   to `conflict`; everything else falls back to `internal`. The `details` field
 *   is not carried over from the source value.
 */
export function toKernelError(err: unknown): KernelException {
  if (err instanceof KernelException) return err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const ownCode =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;
  let code: KernelErrorCode = "internal";
  if (ownCode === "continuation_unavailable") code = "continuation_unavailable";
  else if (name.includes("Validation")) code = "invalid_request";
  else if (name.includes("Conflict")) code = "conflict";
  return new KernelException(code, message);
}
