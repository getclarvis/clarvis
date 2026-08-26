import { CodedError, ProviderError } from "@clarvis/capability";
import type { ErrorCode, RunResponse, Usage } from "@clarvis/capability";
import { sanitizeDeep, sanitizeErrorMessage } from "@clarvis/capability";
import { errorResponse } from "./support/run-response.ts";
import type { AgentResult } from "./loop/loop-shared.ts";

/** Extract the machine-readable detail fields (`kind`, and `status`/`retry_after_ms`
 * when present) from a {@link ProviderError} for the error response's `details`. */
function providerErrorDetails(err: ProviderError): Record<string, unknown> {
  const details: Record<string, unknown> = { kind: err.kind };
  if (err.status !== undefined) details.status = err.status;
  if (err.retryAfterMs !== undefined) details.retry_after_ms = err.retryAfterMs;
  return details;
}

/**
 * The {@link ErrorCode} each actionable {@link ProviderError} kind reports as.
 *
 * @remarks Only the kinds a user resolves differently get their own code;
 * everything else stays `provider_error`, whose `details.kind` still carries the
 * distinction for anyone who wants it. The point of a separate code is that a UI
 * can say "your provider account is out of quota" or "the provider refused this
 * content" instead of one message covering both plus a malformed payload.
 */
const PROVIDER_ERROR_CODES: Partial<Record<ProviderError["kind"], ErrorCode>> = {
  context_overflow: "context_overflow",
  quota: "provider_quota_exhausted",
  content_policy: "provider_content_policy",
};

/**
 * Map a thrown error into a terminal {@link RunResponse}, attaching the given
 * usage.
 *
 * @param err - the caught error.
 * @param usage - the run's accumulated usage to carry on the response.
 * @param signal - if already aborted, the run is reported as `cancelled`
 *   regardless of `err`.
 * @returns a `cancelled` response when the signal aborted; for a
 *   {@link ProviderError}, the code {@link PROVIDER_ERROR_CODES} gives its kind
 *   (falling back to `provider_error`), with sanitized message and detail;
 *   otherwise an `internal_error` response.
 * @remarks Error messages are run through {@link sanitizeErrorMessage} before they
 *   reach the response.
 */
export function mapErrorToResponse(err: unknown, usage: Usage, signal?: AbortSignal): RunResponse {
  if (signal?.aborted) {
    return { status: "cancelled", result: undefined, usage };
  }
  if (err instanceof ProviderError) {
    return errorResponse(
      usage,
      PROVIDER_ERROR_CODES[err.kind] ?? "provider_error",
      sanitizeErrorMessage(err.message),
      providerErrorDetails(err),
    );
  }
  if (err instanceof CodedError) {
    return errorResponse(
      usage,
      err.code,
      sanitizeErrorMessage(err.message),
      err.details === undefined ? undefined : sanitizeDeep(err.details, sanitizeErrorMessage),
    );
  }
  return errorResponse(
    usage,
    "internal_error",
    sanitizeErrorMessage(err instanceof Error ? err.message : "Run terminated unexpectedly."),
  );
}

/**
 * Map a completed agent-loop {@link AgentResult} to a {@link RunResponse},
 * attaching usage and preferring a structured result over text when present.
 *
 * @param loopResult - the loop's terminal outcome.
 * @param usage - the run's accumulated usage to carry on the response.
 * @param fallbackMessage - supplies the message when the loop errored without one,
 *   keyed by the derived {@link ErrorCode} (e.g. role-aware empty-response text).
 * @returns the corresponding response: `completed` carries the structured or text
 *   result; `budget_exhausted`/`cancelled`/`soft_limit_declined` carry the partial
 *   value; `error` carries the loop's code and message (or the fallback).
 * @remarks A missing error code defaults to `empty_response`.
 */
export function loopResultToResponse(
  loopResult: AgentResult,
  usage: Usage,
  fallbackMessage: (code: ErrorCode) => string,
): RunResponse {
  const partialValue = loopResult.partialStructured
    ? loopResult.partialStructured.value
    : loopResult.partialText;
  switch (loopResult.status) {
    case "completed":
      return {
        status: "completed",
        result: loopResult.structuredResult
          ? loopResult.structuredResult.value
          : (loopResult.text ?? loopResult.partialText),
        usage,
      };
    case "budget_exhausted":
      return { status: "budget_exhausted", result: partialValue, usage };
    case "cancelled":
      return { status: "cancelled", result: partialValue, usage };
    case "soft_limit_declined":
      return { status: "soft_limit_declined", result: partialValue, usage };
    case "error": {
      const code = loopResult.error?.code ?? "empty_response";
      return errorResponse(usage, code, loopResult.error?.message ?? fallbackMessage(code));
    }
  }
}
