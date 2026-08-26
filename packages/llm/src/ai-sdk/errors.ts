import { APICallError } from "ai";
import {
  NOOP_LOGGER,
  ProviderError,
  sanitizeErrorMessage,
  type LLMUsage,
  type Logger,
} from "@clarvis/capability";
import { classifyProviderError, type HeaderLike } from "../classify-provider-error.ts";
import { findProviderResponseLimitError } from "./bounded-fetch.ts";

/**
 * Adapts a plain header record into the case-insensitive {@link HeaderLike} the
 * classifier consumes.
 */
function recordToHeaderLike(rec: Record<string, string>): HeaderLike {
  return {
    get(name: string): string | null {
      const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
      return key !== undefined ? (rec[key] ?? null) : null;
    },
  };
}

const MAX_REASON_LEN = 200;

/**
 * Reads the conventional message field out of a parsed JSON error body: a nested
 * `error.message`, a top-level `message`, or a plain string `error`.
 *
 * @param parsed - a value parsed from a provider's JSON error body.
 * @returns the first non-empty message string found, or `undefined`.
 */
function pickBodyMessage(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const o = parsed as { error?: unknown; message?: unknown };
  if (o.error !== null && typeof o.error === "object") {
    const em = (o.error as { message?: unknown }).message;
    if (typeof em === "string" && em.trim().length > 0) return em;
  }
  if (typeof o.error === "string" && o.error.trim().length > 0) return o.error;
  if (typeof o.message === "string" && o.message.trim().length > 0) return o.message;
  return undefined;
}

/**
 * Extracts a short, human-readable explanation from a provider's error response
 * body — the `error.message`/`message`/`error` field of a JSON body, or a plain
 * string body — collapsed to one line, {@link sanitizeErrorMessage | secret-redacted},
 * and capped at {@link MAX_REASON_LEN} characters.
 *
 * @param body - the raw response body from an {@link APICallError}.
 * @returns the cleaned explanation, or `undefined` when the body carries nothing
 *   usable.
 */
function extractProviderReason(body: unknown, logger: Logger): string | undefined {
  let raw: string | undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.length === 0) return undefined;
    try {
      raw = pickBodyMessage(JSON.parse(trimmed)) ?? trimmed;
    } catch {
      logger.debug(
        { event: "llm.error.body_unparsed", body_chars: trimmed.length },
        "the provider's error body was not JSON; the whole body is used as the explanation instead",
      );
      raw = trimmed;
    }
  } else if (body != null) {
    raw = pickBodyMessage(body);
  }
  if (raw === undefined) return undefined;
  const collapsed = sanitizeErrorMessage(raw).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_REASON_LEN
    ? `${collapsed.slice(0, MAX_REASON_LEN - 1)}…`
    : collapsed;
}

/**
 * A short, human-readable label for a known HTTP failure status, so the UI shows
 * "Payment required (HTTP 402)" rather than a bare code.
 *
 * @param status - the HTTP status code from the response.
 * @returns the label; a generic `5xx`/other-code form when the status is unmapped.
 */
function statusLabel(status: number): string {
  switch (status) {
    case 400:
      return "Bad request (HTTP 400)";
    case 401:
      return "Authentication failed (HTTP 401)";
    case 402:
      return "Payment required (HTTP 402)";
    case 403:
      return "Access forbidden (HTTP 403)";
    case 404:
      return "Not found (HTTP 404)";
    case 408:
      return "Request timeout (HTTP 408)";
    case 413:
      return "Request too large (HTTP 413)";
    case 429:
      return "Rate limited (HTTP 429)";
    default:
      if (status >= 500 && status <= 599) return `Provider server error (HTTP ${status})`;
      return `Model call failed (HTTP ${status})`;
  }
}

/**
 * Actionable guidance for a known HTTP failure status, appended only when the
 * provider's body carried no {@link extractProviderReason | explanation of its own}.
 *
 * @param status - the HTTP status code from the response.
 * @returns the guidance clause, or `undefined` for statuses with no useful hint.
 */
function statusGuidance(status: number): string | undefined {
  switch (status) {
    case 401:
    case 403:
      return "check the API key and that it can access this model";
    case 402:
      return "check your provider credits or billing";
    case 404:
      return "check the model id and provider endpoint";
    case 413:
      return "the request exceeded the provider's size limit";
    case 429:
      return "too many requests; retrying may help";
    default:
      if (status >= 500 && status <= 599) return "the provider had a server-side error";
      return undefined;
  }
}

/**
 * Builds the user-facing message for a failed HTTP model call: a
 * {@link statusLabel | status label} enriched with the provider's own
 * {@link extractProviderReason | explanation} when the body carried one, falling
 * back to {@link statusGuidance | status guidance} otherwise.
 *
 * @param status - the resolved HTTP status, when known.
 * @param body - the raw response body to mine for an explanation.
 * @returns the composed, secret-safe message.
 */
function describeHttpFailure(status: number | undefined, body: unknown, logger: Logger): string {
  const label = status !== undefined ? statusLabel(status) : "Model call failed";
  const reason = extractProviderReason(body, logger);
  if (reason !== undefined) return `${label}: ${reason}`;
  const guidance = status !== undefined ? statusGuidance(status) : undefined;
  return guidance !== undefined ? `${label} — ${guidance}.` : `${label}.`;
}

/** The lowest and highest `code` values read as an HTTP status rather than an errno. */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * Recognizes the structured error payload a provider can deliver *inside* a
 * successful stream, rather than as an HTTP failure.
 *
 * @remarks
 * An OpenAI-compatible endpoint that has already flushed response headers cannot
 * change the status code, so it reports a late failure as a data frame carrying
 * `{"error":{"code":429,"message":"…"}}`. The AI SDK forwards that object
 * verbatim, so what reaches {@link toProviderError} is a plain object — neither
 * an `Error` nor an `APICallError`. Without this reading it fell to the transport
 * branch, where the classifier could extract no signal text and defaulted to the
 * non-retryable `client` kind: a plainly retryable rate limit then killed the run
 * on its first occurrence, and the provider's own sentence never reached the
 * message, the trace or the log.
 *
 * Only a non-`Error` object qualifies, and only a numeric `code` inside the HTTP
 * range becomes a status — an `Error` carrying `code: "ECONNRESET"` is a genuine
 * transport failure and must keep reaching the branch below.
 *
 * @param err - the thrown value.
 * @returns the payload to classify against plus any HTTP status it declared, or
 *   `undefined` when the value is not a structured provider error.
 */
function readStructuredProviderError(
  err: unknown,
): { status: number | undefined; body: unknown } | undefined {
  if (err === null || typeof err !== "object" || err instanceof Error) return undefined;
  const outer = err as { error?: unknown };
  const payload: object =
    outer.error !== null && typeof outer.error === "object" ? outer.error : err;
  if (pickBodyMessage(err) === undefined) return undefined;
  const { code, status } = payload as { code?: unknown; status?: unknown };
  const numeric = [code, status].find(
    (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= MIN_HTTP_STATUS && v <= MAX_HTTP_STATUS,
  );
  return { status: numeric as number | undefined, body: err };
}

/**
 * Normalizes any thrown value into a {@link ProviderError} by running it through
 * {@link classifyProviderError} — extracting status/headers/body from an AI SDK
 * {@link APICallError}, or classifying a bare transport error from its cause. The
 * user-facing message is composed by {@link describeHttpFailure}, which surfaces
 * the provider's own (secret-redacted) explanation when present.
 *
 * @param err - the thrown value.
 * @param extra - what the streaming path observed about the failed attempt:
 *   whether output had started and any tokens the provider already billed.
 * @param logger - receives a `debug` when a body degrades the classification —
 *   one that is not JSON, or that cannot be stringified at all. Both are
 *   otherwise swallowed, which is what makes a misclassified failure
 *   unattributable.
 */
export function toProviderError(
  err: unknown,
  extra: { streamStarted?: boolean; partialUsage?: LLMUsage } = {},
  logger: Logger = NOOP_LOGGER,
): ProviderError {
  const subscriptionCode =
    err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
  if (subscriptionCode?.startsWith("subscription_")) {
    const mapped = {
      subscription_unavailable: [
        "client",
        "Subscription integration is unavailable in this build.",
      ],
      subscription_login_required: [
        "auth",
        "Subscription login is required; API-key billing is separate.",
      ],
      subscription_login_failed: ["auth", "Subscription login failed; start a new device login."],
      subscription_reauthentication_required: [
        "auth",
        "Subscription reauthentication is required; API-key billing is separate.",
      ],
      subscription_entitlement_denied: [
        "auth",
        "The connected subscription is not entitled to this model.",
      ],
      subscription_quota_exhausted: [
        "quota",
        "Subscription quota is exhausted; follow the provider's reset or top-up guidance.",
      ],
      subscription_transport_refused: [
        "client",
        "Subscription transport refused an unapproved origin or redirect.",
      ],
      subscription_in_use: [
        "client",
        "Subscription credentials are in use by another Clarvis process.",
      ],
    } as const;
    const projection = mapped[subscriptionCode as keyof typeof mapped];
    if (projection !== undefined) {
      return new ProviderError(projection[1], { kind: projection[0], ...extra });
    }
  }
  const responseLimit = findProviderResponseLimitError(err);
  if (responseLimit !== undefined) {
    return new ProviderError(responseLimit.message, { kind: "client", ...extra });
  }
  if (APICallError.isInstance(err)) {
    const c = classifyProviderError({
      status: err.statusCode,
      headers: err.responseHeaders ? recordToHeaderLike(err.responseHeaders) : undefined,
      body: err.responseBody,
      cause: err,
      isRetryable: err.isRetryable,
      logger,
    });
    const status = c.status ?? err.statusCode;
    const message = describeHttpFailure(status, err.responseBody, logger);
    return new ProviderError(message, {
      kind: c.kind,
      status: c.status,
      retryAfterMs: c.retryAfterMs,
      ...extra,
    });
  }
  const structured = readStructuredProviderError(err);
  if (structured !== undefined) {
    const c = classifyProviderError({
      status: structured.status,
      body: structured.body,
      cause: err,
      logger,
    });
    const status = c.status ?? structured.status;
    return new ProviderError(describeHttpFailure(status, structured.body, logger), {
      kind: c.kind,
      status,
      retryAfterMs: c.retryAfterMs,
      ...extra,
    });
  }
  const c = classifyProviderError({ cause: err, logger });
  return new ProviderError("Model call failed (transport error).", {
    kind: c.kind,
    status: c.status,
    retryAfterMs: c.retryAfterMs,
    ...extra,
  });
}
