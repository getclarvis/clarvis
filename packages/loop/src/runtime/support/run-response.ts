import type { ErrorCode, RunResponse, Usage } from "@clarvis/capability";

/**
 * Build a failed {@link RunResponse} with `status: "error"`.
 *
 * @param usage - the token usage to attach (spend is reported even on failure).
 * @param code - the machine-readable {@link ErrorCode}.
 * @param message - the human-readable error message.
 * @param details - optional structured context, omitted from the payload when
 *   `undefined`.
 * @returns the error-shaped run response.
 */
export function errorResponse(
  usage: Usage,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RunResponse {
  return {
    status: "error",
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    usage,
  };
}
