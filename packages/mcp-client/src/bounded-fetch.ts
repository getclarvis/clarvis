import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "@clarvis/capability";
import { NOOP_LOGGER, detachObserved } from "@clarvis/capability";

/** Default maximum size of one HTTP/SSE MCP response before SDK parsing. */
export const DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Default maximum size of one unterminated MCP SSE event. */
export const DEFAULT_MCP_HTTP_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/** A remote MCP peer exceeded the transport's pre-parse byte budget. */
export class MCPHttpResponseLimitError extends Error {
  readonly code = "mcp_http_response_too_large" as const;
  constructor(
    readonly limit: "response" | "sse_event",
    readonly maxBytes: number,
  ) {
    super(
      limit === "response"
        ? `MCP HTTP response exceeds the ${String(maxBytes)}-byte limit.`
        : `MCP SSE event exceeds the ${String(maxBytes)}-byte limit without a delimiter.`,
    );
    this.name = "MCPHttpResponseLimitError";
  }
}

export interface MCPBoundedFetchOptions {
  fetch?: FetchLike;
  headers?: Readonly<Record<string, string>>;
  maxResponseBytes?: number;
  maxSseEventBytes?: number;
  /** Where a refused response is reported; defaults to a no-op logger. */
  logger?: Logger;
  /**
   * The server this fetch belongs to, for attribution.
   *
   * @remarks Only needed when `logger` carries no `mcp` binding of its own; a
   *   record naming no server is nearly useless on a host with several.
   */
  mcpName?: string;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(fallback, Math.floor(value))
    : fallback;
}

function detachCancel(
  cancel: () => Promise<void>,
  operation: string,
  logger: Logger,
  mcpName: string | undefined,
): void {
  detachObserved(cancel, {
    operation,
    dedupeKey: `${operation}\0${mcpName ?? ""}`,
    logger,
  });
}

/**
 * Bound HTTP response bytes before the MCP SDK materializes JSON-RPC payloads.
 * Cancellation is started and observed, but never awaited on the failure path:
 * a broken transport's cancel algorithm must not defeat the byte limit itself.
 */
export function createMCPBoundedFetch(options: MCPBoundedFetchOptions = {}): FetchLike {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = boundedPositive(
    options.maxResponseBytes,
    DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES,
  );
  const maxSseEventBytes = boundedPositive(
    options.maxSseEventBytes,
    DEFAULT_MCP_HTTP_MAX_SSE_EVENT_BYTES,
  );
  const logger = options.logger ?? NOOP_LOGGER;
  const mcpName = options.mcpName;
  const refused = (kind: "response" | "sse_event", limit: number): void => {
    logger.error(
      {
        event: "mcp.transport.response_limit",
        ...(mcpName !== undefined ? { mcp: mcpName } : {}),
        kind,
        limit,
      },
      "mcp server sent more than the transport accepts before parsing; the request is aborted " +
        "and the call fails",
    );
  };

  return async (input, init) => {
    const upstream = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, upstream.signal]) : upstream.signal;
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
    const response = await baseFetch(input, { ...init, headers, signal });

    const isEventStream =
      response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    const declared = Number(response.headers.get("content-length"));
    if (!isEventStream && Number.isFinite(declared) && declared > maxResponseBytes) {
      const error = new MCPHttpResponseLimitError("response", maxResponseBytes);
      refused("response", maxResponseBytes);
      upstream.abort(error);
      if (response.body !== null) {
        detachCancel(
          () => response.body!.cancel(error),
          "mcp_oversized_declared_body_cancel",
          logger,
          mcpName,
        );
      }
      throw error;
    }
    if (response.body === null) return response;

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let responseBytes = 0;
    let eventBytes = 0;
    let lineBytes = 0;

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
        let limitError: MCPHttpResponseLimitError | undefined;
        responseBytes += chunk.byteLength;
        if (!isEventStream && responseBytes > maxResponseBytes) {
          limitError = new MCPHttpResponseLimitError("response", maxResponseBytes);
        } else if (isEventStream) {
          for (const byte of chunk) {
            eventBytes += 1;
            if (byte === 0x0a) {
              if (lineBytes === 0) eventBytes = 0;
              lineBytes = 0;
            } else if (byte !== 0x0d) {
              lineBytes += 1;
            }
            if (eventBytes > maxSseEventBytes) {
              limitError = new MCPHttpResponseLimitError("sse_event", maxSseEventBytes);
              break;
            }
          }
        }

        if (limitError !== undefined) {
          refused(limitError.limit, limitError.maxBytes);
          upstream.abort(limitError);
          detachCancel(
            () => reader.cancel(limitError),
            "mcp_oversized_stream_cancel",
            logger,
            mcpName,
          );
          controller.error(limitError);
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        upstream.abort(reason);
        detachCancel(() => reader.cancel(reason), "mcp_bounded_stream_cancel", logger, mcpName);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
