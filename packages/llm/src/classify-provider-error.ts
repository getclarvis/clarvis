import { NOOP_LOGGER, type FailureKind, type Logger } from "@clarvis/capability";

/**
 * The minimal case-insensitive header accessor {@link classifyProviderError}
 * needs — the `Headers`-style `get(name)` returning the value or `null`.
 */
export interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Everything the classifier may inspect about a failed call: the HTTP `status`,
 * response `headers` and `body`, the thrown `cause`, whether the call `timedOut`
 * or the SDK flagged it `isRetryable`, and `now` for resolving a `Retry-After`
 * date.
 *
 * @remarks All fields are optional; the classifier degrades gracefully, falling
 *   back to message/body signal matching when structured fields are absent.
 */
export interface ClassifyInput {
  status?: number;
  headers?: HeaderLike;
  body?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isRetryable?: boolean;
  now?: number;
  /**
   * Receives a `debug` when a signal the classifier wanted is unreadable.
   *
   * @remarks Defaults to {@link NOOP_LOGGER} where it is read, never optionally
   *   chained. A body that will not stringify is dropped from the signal text,
   *   so the verdict is reached on less evidence than the caller supplied — the
   *   one degradation here that is otherwise completely silent.
   */
  logger?: Logger;
}

/**
 * The classifier's verdict: the failure `kind` ({@link FailureKind}) plus the
 * `status` and `retryAfterMs` echoed through when they were determinable.
 */
export interface Classification {
  kind: FailureKind;
  status?: number;
  retryAfterMs?: number;
}

const OVERFLOW_SIGNALS = [
  "context length",
  "context_length_exceeded",
  "context window",
  "maximum context",
  "max context",
  "too many tokens",
  "reduce the length",
  "string too long",
  "maximum_tokens",
  "prompt is too long",
];

const OVERLOAD_SIGNALS = [
  "overloaded",
  "overloaded_error",
  "unavailable",
  "temporarily",
  "try again",
  "rate limit",
  "rate_limit",
  "too many requests",
];

const QUOTA_SIGNALS = [
  "insufficient_quota",
  "exceeded your current quota",
  "quota exceeded",
  "billing hard limit",
  "billing_hard_limit_reached",
];

/**
 * Signals that the provider refused the request on content grounds.
 *
 * @remarks Tested *after* {@link QUOTA_SIGNALS} on purpose: a quota or billing
 * body occasionally carries the word "safety" in boilerplate, and the reverse
 * ordering would file a spend problem as a policy refusal - sending the user to
 * rewrite a prompt that was never the issue.
 *
 * Every entry is a multi-word or underscored token for the same reason. A bare
 * `"safety"` matched Azure and Bedrock boilerplate that rides along on ordinary
 * rate-limit and overload responses, and because this table is tested ahead of
 * the `429`/`529`/`5xx` rules it would have turned those retryable failures
 * into permanent refusals.
 */
const CONTENT_POLICY_SIGNALS = [
  "content_policy",
  "content policy",
  "content_filter",
  "content filter",
  "responsibleaipolicyviolation",
  "safety filter",
  "safety_violation",
  "blocked_by_safety",
];

/**
 * Joins a failure's response body and thrown cause into one lowercase search
 * string for {@link containsAny} signal matching.
 *
 * @param input - the observed failure signals; see {@link ClassifyInput}.
 * @returns the body (stringified when not already a string) and cause message,
 *   space-joined and lowercased; a body that fails to stringify is skipped.
 */
function textOf(input: ClassifyInput): string {
  const parts: string[] = [];
  if (typeof input.body === "string") parts.push(input.body);
  else if (input.body != null) {
    try {
      parts.push(JSON.stringify(input.body));
    } catch {
      (input.logger ?? NOOP_LOGGER).debug(
        { event: "llm.error.body_unstringifiable" },
        "the provider's error body could not be stringified; the failure is classified without it",
      );
    }
  }
  const cause = input.cause;
  if (cause instanceof Error) parts.push(cause.message);
  else if (typeof cause === "string") parts.push(cause);
  else if (cause != null && typeof cause === "object") {
    try {
      parts.push(JSON.stringify(cause));
    } catch {
      (input.logger ?? NOOP_LOGGER).debug(
        { event: "llm.error.cause_unstringifiable" },
        "the provider's error cause could not be stringified; the failure is classified without it",
      );
    }
  }
  return parts.join(" ").toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

const NETWORK_ERROR_SIGNALS = [
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "enetdown",
  "epipe",
  "eproto",
  "fetch failed",
  "network error",
  "socket hang up",
  "other side closed",
  "premature close",
  "connection terminated",
  "connection closed",
  "connection error",
  "und_err",
  "request timed out",
  "timed out",
  "timeout",
];

/**
 * Whether a thrown cause looks like a transport/network fault, by walking its
 * `name`/`message`/`code`, nested `cause`, and aggregated `errors` (up to 3
 * levels deep) and matching against {@link NETWORK_ERROR_SIGNALS}.
 */
function isNetworkErrorLike(cause: unknown): boolean {
  const parts: string[] = [];
  const collect = (e: unknown, depth: number): void => {
    if (e == null || depth > 3) return;
    if (typeof e === "string") {
      parts.push(e);
      return;
    }
    if (typeof e !== "object") return;
    const o = e as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof o.name === "string") parts.push(o.name);
    if (typeof o.message === "string") parts.push(o.message);
    if (typeof o.code === "string" || typeof o.code === "number") parts.push(String(o.code));
    collect(o.cause, depth + 1);
    if (Array.isArray(o.errors)) for (const sub of o.errors) collect(sub, depth + 1);
  };
  collect(cause, 0);
  return containsAny(parts.join(" ").toLowerCase(), NETWORK_ERROR_SIGNALS);
}

/**
 * Parses a `Retry-After`-style header value into a delay in milliseconds.
 *
 * @param value - the raw header value; a number of seconds (whole or decimal)
 *   or an HTTP-date. `null`/`undefined`/blank yields `undefined`.
 * @param now - the reference time used to turn an HTTP-date into a relative
 *   delay; defaults to {@link Date.now}.
 * @returns the delay in milliseconds (never negative), or `undefined` when the
 *   value is absent or unparseable.
 * @remarks Decimal seconds are accepted because providers send them:
 *   `x-ratelimit-reset-after: 1.5` is a real value, and an integer-only rule
 *   discarded it entirely — falling back to exponential backoff and ignoring
 *   the one authoritative statement about when to try again.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, Math.round(seconds * 1000));
  }
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.round(dateMs - now));
}

/**
 * Reads a retry delay off the response headers, checking the millisecond-
 * precision header first, then the standard `Retry-After`, then
 * provider-specific rate-limit headers.
 *
 * @param headers - the response headers, when available.
 * @param now - the reference time for resolving an HTTP-date value; see
 *   {@link parseRetryAfter}.
 * @returns the first parseable delay in milliseconds, in header-priority
 *   order, or `undefined` when none of the candidates parse.
 * @remarks `retry-after-ms` is checked first because it is the only candidate
 *   already denominated in milliseconds, so it needs no rounding through
 *   seconds; when a provider sends both, it is the more precise of the two.
 */
function readRetryAfter(
  headers: HeaderLike | undefined,
  now: number | undefined,
): number | undefined {
  if (!headers) return undefined;
  const raw = headers.get("retry-after-ms");
  if (raw != null && /^[0-9]+(\.[0-9]+)?$/.test(raw.trim())) {
    const ms = Number(raw.trim());
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  }
  const candidates = [
    headers.get("retry-after"),
    headers.get("x-ratelimit-reset-after"),
    headers.get("anthropic-ratelimit-unified-reset"),
  ];
  for (const c of candidates) {
    const ms = parseRetryAfter(c, now);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/**
 * Classifies a failed model call into a {@link FailureKind} the loop can act on,
 * combining HTTP status, retry hints, and message/body signal matching.
 *
 * @param input - the observed failure signals; see {@link ClassifyInput}.
 * @returns the {@link Classification}, always carrying `status` and
 *   `retryAfterMs` when they were determinable.
 * @remarks Precedence is deliberate: context-overflow text wins first, then
 *   quota text (`"quota"`), then content-policy text (`"content_policy"`), then
 *   `401/403` (`"auth"`); `429`/`529`/`5xx`/`2xx`, a timeout, an SDK
 *   `isRetryable` flag, or a network-error cause with no status are all
 *   `"transient"`; other `4xx` is `"client"`; overload text is a last
 *   `"transient"` catch; anything else defaults to `"client"`. A `2xx` counts as
 *   transient because reaching the classifier with a success status means the
 *   body was malformed or truncated.
 *
 *   `"quota"` and `"content_policy"` used to be indistinguishable from a
 *   malformed payload, though a user acts on them very differently - one needs
 *   an account topped up, the other needs the request rephrased. Neither is
 *   retryable, and neither needs to say so here: the retry wrapper only retries
 *   `"transient"`, so splitting them out of `"client"` makes them
 *   non-retryable by construction.
 */
export function classifyProviderError(input: ClassifyInput): Classification {
  const status = typeof input.status === "number" ? input.status : undefined;
  const text = textOf(input);
  const retryAfterMs = readRetryAfter(input.headers, input.now);
  const withExtras = (kind: FailureKind): Classification => ({
    kind,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  if (containsAny(text, OVERFLOW_SIGNALS)) return withExtras("context_overflow");

  if (containsAny(text, QUOTA_SIGNALS)) return withExtras("quota");

  if (containsAny(text, CONTENT_POLICY_SIGNALS)) return withExtras("content_policy");

  if (status === 401 || status === 403) return withExtras("auth");

  if (
    status === 429 ||
    status === 529 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    (status !== undefined && status >= 200 && status <= 299) ||
    input.timedOut === true ||
    input.isRetryable === true ||
    (status === undefined && isNetworkErrorLike(input.cause))
  ) {
    return withExtras("transient");
  }

  if (status !== undefined && status >= 400 && status <= 499) return withExtras("client");

  if (containsAny(text, OVERLOAD_SIGNALS)) return withExtras("transient");

  return withExtras("client");
}
