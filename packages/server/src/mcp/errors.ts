import type { KernelErrorCode } from "@clarvis/protocol";

/**
 * Error codes the facade reports to a caller, mirroring the kernel's own
 * vocabulary so a client sees one code space.
 *
 * @remarks `forbidden` is the one code the kernel does not have. Authorization
 * is a facade concern — the kernel has no notion of a role — so a refusal that
 * originates here needs a code of its own rather than being flattened into
 * `unauthorized`, which a client would read as "present a better credential".
 */
export type ServerErrorCode = KernelErrorCode | "forbidden";

/** Runtime counterpart of {@link ServerErrorCode}, kept exhaustive against the protocol union. */
const SERVER_ERROR_CODES = new Set<ServerErrorCode>([
  "unauthorized",
  "not_found",
  "invalid_request",
  "conflict",
  "unavailable",
  "unsupported",
  "cancelled",
  "capability_disabled",
  "continuation_unavailable",
  "resource_exhausted",
  "internal",
  "forbidden",
]);

/** A facade-level failure carrying a {@link ServerErrorCode} and optional detail. */
export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ServerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServerError";
    this.code = code;
    this.details = details;
  }
}

/** Build a {@link ServerError}. */
export function serverError(
  code: ServerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ServerError {
  return new ServerError(code, message, details);
}

/**
 * Narrow an unknown throw to a reportable shape.
 *
 * @param err - the caught value.
 * @returns the code, message and any details to put in a tool-result envelope.
 * @remarks A kernel error (`{ code, message }`) keeps its code when it names one
 *   this facade also uses; anything else degrades to `internal`, so an unexpected
 *   throw never leaks a stack to the caller.
 */
export function mapError(err: unknown): {
  code: ServerErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  if (err instanceof ServerError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  const candidate = err as { code?: unknown; message?: unknown } | null;
  const message =
    typeof candidate?.message === "string" && candidate.message.length > 0
      ? candidate.message
      : String(err);
  const code = typeof candidate?.code === "string" ? candidate.code : "internal";
  return {
    code: SERVER_ERROR_CODES.has(code as ServerErrorCode) ? (code as ServerErrorCode) : "internal",
    message,
  };
}
