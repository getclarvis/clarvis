import { NOOP_LOGGER, suppressSecondaryRejection, type Logger } from "@clarvis/capability";

/** Default maximum size of one provider response body (32 MiB). */
export const DEFAULT_PROVIDER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Default maximum size of one unterminated SSE event (4 MiB). */
export const DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/** A provider response exceeded one of the adapter's transport bounds. */
export class ProviderResponseLimitError extends Error {
  readonly limit: "response" | "sse_event";
  readonly maxBytes: number;

  constructor(limit: "response" | "sse_event", maxBytes: number) {
    super(
      limit === "response"
        ? `Provider response exceeded the ${String(maxBytes)} byte limit.`
        : `Provider SSE event exceeded the ${String(maxBytes)} byte limit without a delimiter.`,
    );
    this.name = "ProviderResponseLimitError";
    this.limit = limit;
    this.maxBytes = maxBytes;
  }
}

export interface BoundedFetchOptions {
  maxResponseBytes?: number;
  maxSseEventBytes?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * Where a breached bound is reported; defaults to discarding it.
   *
   * @remarks Normalized to {@link NOOP_LOGGER} inside
   *   {@link createBoundedFetch}, so nothing on the read path is optionally
   *   chained.
   */
  logger?: Logger;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Start transport cancellation without letting a non-cooperative cancel
 * algorithm delay the already-decided response/abort outcome. */
function detachCancellation(run: () => unknown, observedBy: string): void {
  try {
    suppressSecondaryRejection(Promise.resolve(run()), observedBy);
  } catch {
    // The primary limit/cancel path already owns the result. A synchronous
    // cleanup failure is secondary for the same reason as a late rejection.
  }
}

/**
 * Wrap `fetch` with streaming byte limits, before an SDK parser can retain an
 * arbitrarily large response or an SSE parser can accumulate an event forever.
 */
export function createBoundedFetch(options: BoundedFetchOptions = {}): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_PROVIDER_MAX_RESPONSE_BYTES);
  const maxSseEventBytes = positive(options.maxSseEventBytes, DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES);
  const logger = options.logger ?? NOOP_LOGGER;

  /**
   * Reports a breached transport bound.
   *
   * @param limit - which bound gave way.
   * @param maxBytes - the bound's value.
   * @param bytesRead - how much of the body had been read when it did.
   * @param extra - fields specific to one site.
   * @remarks A `warn`, and the only place the two fields the error carries
   *   survive: {@link toProviderError} flattens a
   *   {@link ProviderResponseLimitError} to a plain `client` failure, so
   *   `limit` and `maxBytes` reach nothing downstream.
   */
  const reportLimit = (
    limit: "response" | "sse_event",
    maxBytes: number,
    bytesRead: number,
    extra: Record<string, number> = {},
  ): void => {
    logger.warn(
      {
        event: "llm.transport.limit_exceeded",
        limit,
        max_bytes: maxBytes,
        bytes_read: bytesRead,
        ...extra,
      },
      "the provider response breached a transport bound and was cut off; the attempt fails as a client error",
    );
  };

  const bounded = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const upstream = new AbortController();
    const parent = init?.signal;
    const signal = parent ? AbortSignal.any([parent, upstream.signal]) : upstream.signal;
    const response = await baseFetch(input, { ...init, signal });

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      reportLimit("response", maxResponseBytes, 0, { declared_bytes: declared });
      const error = new ProviderResponseLimitError("response", maxResponseBytes);
      upstream.abort(error);
      detachCancellation(() => response.body?.cancel(error), "provider response-size limit error");
      throw error;
    }
    if (response.body === null) return response;

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const isEventStream =
      response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    let responseBytes = 0;
    let eventBytes = 0;
    let lineBytes = 0;

    const fail = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      error: ProviderResponseLimitError,
    ): void => {
      upstream.abort(error);
      detachCancellation(() => reader.cancel(error), "provider streaming response limit error");
      controller.error(error);
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (read.done) {
          controller.close();
          return;
        }

        const chunk = read.value;
        responseBytes += chunk.byteLength;
        if (responseBytes > maxResponseBytes) {
          reportLimit("response", maxResponseBytes, responseBytes);
          fail(controller, new ProviderResponseLimitError("response", maxResponseBytes));
          return;
        }

        for (const byte of isEventStream ? chunk : []) {
          eventBytes += 1;
          if (byte === 0x0a) {
            if (lineBytes === 0) eventBytes = 0;
            lineBytes = 0;
          } else if (byte !== 0x0d) {
            lineBytes += 1;
          }
          if (eventBytes > maxSseEventBytes) {
            reportLimit("sse_event", maxSseEventBytes, responseBytes, { event_bytes: eventBytes });
            fail(controller, new ProviderResponseLimitError("sse_event", maxSseEventBytes));
            return;
          }
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        upstream.abort(reason);
        detachCancellation(() => reader.cancel(reason), "provider response consumer cancellation");
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return bounded as typeof globalThis.fetch;
}

/** Find a limit error through the shallow cause chains SDK errors use. */
export function findProviderResponseLimitError(
  error: unknown,
): ProviderResponseLimitError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ProviderResponseLimitError) return current;
    if ((typeof current !== "object" && typeof current !== "function") || seen.has(current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
