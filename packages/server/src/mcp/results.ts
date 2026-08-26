import { mapError, type ServerErrorCode } from "./errors.ts";

/** Namespace for this facade's `_meta` keys, keeping them out of MCP's own space. */
const META_NS = "dev.clarvis";

/**
 * The subset of the MCP `CallToolResult` shape this module builds.
 *
 * @remarks The index signature is what makes it assignable to the SDK's own
 * result type, which is open for protocol extensions.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Build a successful tool result.
 *
 * @param envelope - the structured payload, also mirrored as JSON text so a
 *   client without structured-content support still sees it.
 * @param meta - extra `_meta` entries, already namespaced.
 * @returns the MCP tool result.
 */
export function toolResult(
  envelope: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    ...(meta !== undefined && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/**
 * Build an error tool result.
 *
 * @remarks Returned as `isError: true` rather than thrown, so the model sees a
 * readable, retryable message instead of a protocol-level failure. The SDK skips
 * output-schema validation for error results, so this shape need not match the
 * tool's declared output.
 */
export function errorResult(
  code: ServerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolResult {
  const envelope: Record<string, unknown> = {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  };
}

/** Turn an unknown throw into an error result. */
export function errorResultFrom(err: unknown): ToolResult {
  const mapped = mapError(err);
  return errorResult(mapped.code, mapped.message, mapped.details);
}

/** `_meta` block reporting live-stream fidelity for a run. */
export function streamMeta(stats: {
  events_sent: number;
  deltas_coalesced: number;
  events_dropped: number;
  wedged: boolean;
  truncated: boolean;
}): Record<string, unknown> {
  return { [`${META_NS}/stream`]: stats };
}

/** `_meta` block reporting the elicitation posture a run was shaped to. */
export function postureMeta(posture: unknown): Record<string, unknown> {
  return { [`${META_NS}/posture`]: posture };
}
