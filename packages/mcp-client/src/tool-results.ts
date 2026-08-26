import type { ToolResult } from "@clarvis/capability";

export function abortedResult(label: string, outcomeUnknown = false): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_runtime_error",
      message: `Tool '${label}' call aborted (run cancelled).`,
      kind: "cancelled",
      ...(outcomeUnknown ? { outcome: "unknown" as const } : {}),
    },
  };
}

export function runtimeErrorResult(label: string, err: unknown): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_runtime_error",
      message: `Tool '${label}' failed: ${errorText(err)}`,
      kind: "operational",
    },
  };
}

export function unavailableResult(mcpName: string): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_unavailable",
      message: `MCP '${mcpName}' is unavailable.`,
      kind: "unavailable",
    },
  };
}

export function interruptedResult(label: string, err: unknown): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_runtime_error",
      message:
        `Tool '${label}' failed in transit: ${errorText(err)}. ` +
        "The connection was restored, but the call may or may not have executed on the server — " +
        "retry only if running it twice is safe.",
      kind: "operational",
      outcome: "unknown",
    },
  };
}

export function becameUnavailableResult(mcpName: string, err: unknown): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_unavailable",
      message: `MCP '${mcpName}' became unavailable: ${errorText(err)}`,
      kind: "unavailable",
      outcome: "unknown",
    },
  };
}

export function timeoutResult(label: string, timeoutMs: number): ToolResult {
  return {
    ok: false,
    error: {
      code: "mcp_timeout",
      message: `Tool '${label}' timed out after ${timeoutMs}ms (still connected).`,
      kind: "timeout",
      outcome: "unknown",
    },
  };
}

/**
 * Map a raw MCP `tools/call` response onto a {@link ToolResult}.
 *
 * @param result - the value the SDK resolved the call with.
 * @param label - the tool name used in generated messages.
 * @returns `{ ok: true, data: result }` for an ordinary response; an
 *   `mcp_runtime_error` when the server flagged `isError`, carrying the first
 *   readable text of its `content` or a labelled fallback; and the same
 *   `operational` error shape when `result` is nullish.
 * @remarks The nullish branch is defence in depth for the `MCPClientFactory`
 *   substitution seam, **not** for the real SDK: a
 *   `tools/call` response is parsed against `CallToolResultSchema`, which
 *   extends a `z.looseObject`, so a `null` payload resolves as a rejection and
 *   never reaches this mapper. A stand-in client handed back by a host or a
 *   test can resolve `null`, and without the branch the dereference of
 *   `.isError` throws a `TypeError` from inside the resilient session's
 *   transport `try` — which reads it as a dropped connection, forces a
 *   reconnect, and tells the caller the call "may or may not have executed".
 *   Reporting `operational` with no `outcome` is the truthful degradation: a
 *   response did arrive, so nothing about whether the server ran the tool is in
 *   doubt; only the payload is unusable. Returning `{ ok: true, data: null }`
 *   instead would merely move the same dereference into the engine's MCP
 *   dispatch, where it is no longer catchable.
 */
export function interpretCallResult(result: unknown, label: string): ToolResult {
  if (result === null || result === undefined) {
    return {
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message: `Tool '${label}' returned no result.`,
        kind: "operational",
      },
    };
  }
  if ((result as { isError?: boolean }).isError === true) {
    return {
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message:
          extractErrorText((result as { content?: unknown }).content) ??
          `Tool '${label}' returned an error.`,
        kind: "operational",
      },
    };
  }
  return { ok: true, data: result };
}

function extractErrorText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
