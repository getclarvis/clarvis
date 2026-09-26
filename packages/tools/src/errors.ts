import { warn } from "./lib/log.ts";
import { isIsolationSetupError } from "./execution/isolation-port.ts";

/**
 * The closed set of machine-readable error codes a {@link ToolError} may carry.
 * Codes are stable identifiers a client can branch on, independent of the
 * human-readable message.
 */
export const ERROR_CODES = [
  "invalid_input",
  "not_found",
  "not_a_file",
  "is_binary",
  "not_an_image",
  "no_match",
  "ambiguous_match",
  "patch_failed",
  "io_error",
  "cross_device",
  "commit_partial",
  "revision_conflict",
  "timeout",
  "aborted",
  "too_large",
  "denied",
  "too_many_sessions",
  "internal",
  "sandbox_unavailable",
  "sandbox_setup_failed",
  "sandbox_denied",
  "outcome_unknown",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A tool failure carrying a stable {@link ErrorCode} plus optional structured
 * fields. Handlers throw this for expected, reportable failures; the dispatcher
 * catches it and renders it via {@link serializeError} rather than surfacing a
 * raw stack.
 */
export class ToolError extends Error {
  /** The stable, machine-readable failure code. */
  readonly code: ErrorCode;
  /** Extra structured context merged into the serialized error (e.g. `path`). */
  readonly fields: Record<string, unknown>;

  /**
   * @param code - the stable {@link ErrorCode} for this failure.
   * @param message - a human-readable description.
   * @param fields - optional structured context spread into the serialized JSON.
   */
  constructor(code: ErrorCode, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.fields = fields;
  }
}

/**
 * Render any thrown value as a compact JSON error string for return to the
 * caller.
 *
 * @param err - the thrown value.
 * @returns a JSON string. A {@link ToolError} serializes to its `code`,
 *   `message`, and spread `fields`; any other value is logged (its stack) and
 *   collapsed to a generic `"internal"` error so implementation detail never
 *   leaks to the model.
 * @remarks Non-{@link ToolError} throws are treated as bugs: the real detail
 *   goes to the warn sink and the caller sees only `internal error`.
 */
export function serializeError(err: unknown): string {
  if (isIsolationSetupError(err)) {
    return JSON.stringify({
      error: err.code,
      message: err.message,
      execution_started: false,
      ...(err.boundary
        ? {
            execution_mode: "sandbox",
            execution_backend: err.boundary.backend,
            policy_id: err.boundary.policyId,
          }
        : {}),
    });
  }
  if (err instanceof ToolError) {
    return JSON.stringify({ error: err.code, message: err.message, ...err.fields });
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  warn(`clarvis-tools: internal error: ${detail}\n`, {
    event: "tools.internal_error",
    level: "error",
    fields: { err: detail },
  });
  return JSON.stringify({ error: "internal", message: "internal error" });
}

/**
 * Map a Node filesystem error to a {@link ToolError} with the closest matching
 * {@link ErrorCode}.
 *
 * @param err - the caught `errno` exception.
 * @param path - the path being operated on, echoed into the message and `fields`.
 * @returns `not_found` for `ENOENT`, `not_a_file` for `EISDIR`/`ENOTDIR`, and
 *   `io_error` for anything else.
 * @remarks
 * The `io_error` fallback is the one branch that reports an errno this mapping
 * does not recognize, and it is reported through the warn sink because it is the
 * only channel that outlives a tool result.
 *
 * The unusual errno is emitted at `debug` for diagnosis without changing the
 * tool result's ordinary error mapping.
 */
export function fsError(err: NodeJS.ErrnoException, path: string): ToolError {
  if (err.code === "ENOENT") return new ToolError("not_found", `No such file: ${path}`, { path });
  if (err.code === "EISDIR")
    return new ToolError("not_a_file", `Path is a directory: ${path}`, { path });
  if (err.code === "ENOTDIR")
    return new ToolError("not_a_file", `Not a directory: ${path}`, { path });
  if (err.code === "EXDEV")
    return new ToolError("cross_device", `Cross-filesystem move requires a copy: ${path}`, {
      path,
    });
  warn(`clarvis-tools: unmapped filesystem error at ${path}: ${err.code ?? "EIO"}\n`, {
    event: "tools.fs_error_unmapped",
    level: "debug",
    fields: {
      errno_code: err.code ?? null,
      syscall: err.syscall ?? null,
      path,
      platform: process.platform,
    },
  });
  return new ToolError("io_error", `${err.code ?? "EIO"}: ${err.message}`, {
    path,
    errno_code: err.code ?? "EIO",
  });
}
