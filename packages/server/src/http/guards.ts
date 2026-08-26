import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { serverError } from "../mcp/errors.ts";

/** Origin/Host policy for the HTTP endpoint. */
export interface GuardOptions {
  /** Accepted `Origin` values; empty means same-origin-only browsers are not the client. */
  allowedOrigins: readonly string[];
  /** Accepted `Host` values; empty accepts any. */
  allowedHosts: readonly string[];
  maxBodyBytes: number;
}

/**
 * Reject a request whose `Origin` or `Host` is not allow-listed.
 *
 * @param request - the inbound request.
 * @param opts - the configured allow-lists.
 * @param logger - the request-bound diagnostic channel.
 * @returns a `Response` to send instead of handling, or `undefined` to proceed.
 * @remarks DNS-rebinding defence, enforced here rather than through the SDK's own
 *   (deprecated) options so the policy lives with the rest of the edge checks.
 *   An empty list means "not enforced" — the deployment's network is the boundary.
 */
export function checkOriginAndHost(
  request: Request,
  opts: GuardOptions,
  logger: Logger = NOOP_LOGGER,
): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin !== null && opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(origin)) {
    return blocked(logger, "origin", origin);
  }
  const host = request.headers.get("host");
  if (host !== null && opts.allowedHosts.length > 0 && !opts.allowedHosts.includes(host)) {
    return blocked(logger, "host", host);
  }
  return undefined;
}

/**
 * Refuse a request the edge allow-lists do not admit, and say which one.
 *
 * @param logger - the request-bound diagnostic channel.
 * @param reason - which allow-list rejected it.
 * @param value - the header value that was not on that list.
 * @returns the `403` to answer with.
 */
function blocked(logger: Logger, reason: "origin" | "host", value: string): Response {
  logger.warn(
    { event: "http.guard.blocked", reason, value },
    `the ${reason} allow-list refused this request; nothing downstream of the edge saw it`,
  );
  return new Response(`${reason} not allowed`, { status: 403 });
}

/**
 * Consume at most `maxBodyBytes` from a request stream.
 *
 * @returns UTF-8 text, or `null` when either the declared or observed body is too large.
 * @remarks `Request.text()` validates size only after allocating the whole body. Reading the
 * stream directly is what makes the configured limit an allocation bound for chunked requests.
 */
export async function readBoundedBodyText(
  request: Request,
  maxBodyBytes: number,
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBodyBytes) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

/** A read JSON-RPC body, with the byte count a request log reports. */
export interface JsonBody {
  /** The parsed value, or `undefined` for a body-less method. */
  body: unknown;
  /** How many bytes the body occupied on the wire. */
  bytes: number;
}

/**
 * Refuse a body the edge will not parse, and say why.
 *
 * @param logger - the request-bound diagnostic channel.
 * @param reason - whether the body was too large or not JSON.
 * @param limit - the configured byte ceiling.
 * @returns the error to throw.
 * @remarks Only the reason and the limit are recorded. The parsed value is a
 * JSON-RPC envelope whose `clarvis_run` arguments carry the user's prompt, so
 * the body itself is never a field — see `specs/cross-cutting/observability.md` §3.5.
 */
function rejectBody(
  logger: Logger,
  reason: "oversized" | "not_json",
  limit: number,
): ReturnType<typeof serverError> {
  logger.debug(
    { event: "http.body.rejected", reason, limit },
    "the request body was refused at the edge; the caller received a 400",
  );
  return reason === "oversized"
    ? serverError("invalid_request", `request body exceeds ${limit} bytes`)
    : serverError("invalid_request", "request body is not valid JSON");
}

/**
 * Read and parse a JSON-RPC body, bounded by size.
 *
 * @param request - the inbound request.
 * @param maxBodyBytes - the configured ceiling.
 * @param logger - the request-bound diagnostic channel.
 * @returns the parsed body and its wire size; see {@link JsonBody}.
 * @throws a `invalid_request` {@link ServerError} when the body is oversized or
 *   not valid JSON.
 * @remarks The facade pre-parses so it can route by owner and correlate a
 *   dropped POST with the runs its JSON-RPC ids started; the parsed value is then
 *   handed to the transport rather than being read twice.
 */
export async function readJsonBody(
  request: Request,
  maxBodyBytes: number,
  logger: Logger = NOOP_LOGGER,
): Promise<JsonBody> {
  if (request.method !== "POST") return { body: undefined, bytes: 0 };
  const text = await readBoundedBodyText(request, maxBodyBytes);
  if (text === null) throw rejectBody(logger, "oversized", maxBodyBytes);
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.trim().length === 0) return { body: undefined, bytes };
  try {
    return { body: JSON.parse(text), bytes };
  } catch {
    throw rejectBody(logger, "not_json", maxBodyBytes);
  }
}

/** Whether a parsed JSON-RPC body is an `initialize` request. */
export function isInitializeBody(body: unknown): boolean {
  return methodsOf(body).includes("initialize");
}

/**
 * The JSON-RPC method names a parsed body carries.
 *
 * @param body - the parsed request body.
 * @returns every `method` present, in order; empty when the body names none.
 */
function methodsOf(body: unknown): string[] {
  const one = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const method = (value as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  };
  const values = Array.isArray(body) ? body : [body];
  return values.map(one).filter((method): method is string => method !== undefined);
}

/** How many of a batch's method names the log field names. */
const MAX_LOGGED_RPC_METHODS = 4;

/** How much of one method name the log field keeps. */
const MAX_LOGGED_RPC_METHOD_CHARS = 64;

/**
 * One method name, bounded.
 *
 * @param method - the name as the body spelled it.
 * @returns the name, or a marked prefix of it.
 */
function boundedMethodName(method: string): string {
  return method.length <= MAX_LOGGED_RPC_METHOD_CHARS
    ? method
    : `${method.slice(0, MAX_LOGGED_RPC_METHOD_CHARS)}[+${String(method.length - MAX_LOGGED_RPC_METHOD_CHARS)} chars]`;
}

/**
 * The JSON-RPC method a request log names.
 *
 * @param body - the parsed request body.
 * @returns the single method, `undefined` when there is none, or a bounded
 *   joined list for a batch — a field value is a scalar by convention, so an
 *   array would arrive as a nested array nothing downstream filters on.
 * @remarks Both the count and each name are capped, and the field says so when
 *   it truncated. This value comes from an unauthenticated, unvalidated body:
 *   the request is logged at the **default** `CLARVIS_SERVER_LOG_REQUESTS=errors`
 *   posture (a batch carrying no `mcp-session-id` is answered `400`, which that
 *   mode records) and the field is set **before** authentication runs. Joined
 *   without a cap, a 4 MiB body of `{"method":"x"}` — the default ceiling —
 *   yields roughly 260,000 entries and a half-megabyte log field, so an
 *   anonymous caller decides how much an operator's disk absorbs per request.
 */
export function rpcMethodOf(body: unknown): string | undefined {
  const methods = methodsOf(body);
  if (methods.length === 0) return undefined;
  const named = methods.slice(0, MAX_LOGGED_RPC_METHODS).map(boundedMethodName).join(",");
  const omitted = methods.length - Math.min(methods.length, MAX_LOGGED_RPC_METHODS);
  return omitted === 0 ? named : `${named},[+${String(omitted)} more]`;
}
