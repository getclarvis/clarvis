import { ErrorCode as McpErrorCode } from "@modelcontextprotocol/sdk/types.js";

/** A background run declined to wait behind the physical-connect gate. */
export class MCPBackgroundConnectDeferredError extends Error {
  readonly code = "mcp_background_connect_deferred" as const;

  constructor(
    readonly limit: number,
    readonly resource: "connections" | "handshakes" = "handshakes",
  ) {
    super(
      `MCP connect admission is busy (${String(limit)} concurrent ${resource}); ` +
        "this MCP is inactive for the current run.",
    );
    this.name = "MCPBackgroundConnectDeferredError";
  }
}

/**
 * Whether an error is an MCP request-timeout — a JSON-RPC error whose numeric
 * `code` is {@link McpErrorCode.RequestTimeout}.
 *
 * @param err - the caught value.
 * @returns `true` for a timeout; the connection stays up, so the call may be
 *   retried and repeated timeouts feed the circuit-breaker streak.
 */
export function isMcpRequestTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === McpErrorCode.RequestTimeout
  );
}

const PROTOCOL_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  McpErrorCode.InvalidRequest,
  McpErrorCode.MethodNotFound,
  McpErrorCode.InvalidParams,
  McpErrorCode.InternalError,
  McpErrorCode.ParseError,
]);

/**
 * Whether an error is an MCP protocol-level error — a JSON-RPC error whose
 * `code` is one of `InvalidRequest`, `MethodNotFound`, `InvalidParams`,
 * `InternalError` or `ParseError`.
 *
 * @param err - the caught value.
 * @returns `true` for a protocol error; these are treated as a definitive
 *   per-call runtime error (surfaced to the model, not a transport fault), so
 *   they never trigger a reconnect or count toward the circuit-breaker.
 */
export function isMcpProtocolError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" && PROTOCOL_ERROR_CODES.has(code);
}
