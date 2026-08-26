import { randomUUID } from "node:crypto";
import { malformedArgumentsMessage } from "@clarvis/capability";
import type { LLMToolCall, TracePort } from "@clarvis/capability";
import type { NamespacedRegistry } from "@clarvis/capability";
import type { ConvergenceGuards } from "../guards/convergence-guards.ts";
import type { ToolArgValidator } from "./tool-arg-validator.ts";
import type { AgentRole, ToolResultImage } from "@clarvis/capability";
import { safeStringify } from "../support/stringify.ts";

/**
 * The outcome of dispatching one MCP tool call: the model-facing `resultText`,
 * the `errText` (or `null` on success), whether the call was `productive`
 * (counted against convergence guards), and any extracted `images`.
 *
 * @remarks `productive` distinguishes a call that *did something* from one that
 *   failed before reaching the server: an unknown tool, a rejected argument
 *   schema and a transport-level `mcp_unavailable` are all non-productive,
 *   because in none of them did a tool run. `mcp_unavailable` is the only error
 *   *code* singled out, since every other code comes back from a server that did
 *   receive the call.
 *
 *   Nothing in the engine currently reads it. Both progress predicates the
 *   engine builds — `build-lead-input.ts` and `build-subagent-input.ts` — decide
 *   on `errText === null` alone, and their unit tests pin that they ignore this
 *   field. It is computed and reported for a host that wants a finer signal than
 *   success-or-failure; the loop's own convergence guards do not use one.
 */
export interface McpCallResult {
  resultText: string;
  errText: string | null;
  productive: boolean;
  images?: ToolResultImage[];
}

/** An MCP `content` entry carrying an inline base64 image with its MIME type. */
interface McpImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** Narrow an arbitrary MCP content item to a well-formed {@link McpImageBlock}. */
function isMcpImageBlock(item: unknown): item is McpImageBlock {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { type?: unknown }).type === "image" &&
    typeof (item as { data?: unknown }).data === "string" &&
    typeof (item as { mimeType?: unknown }).mimeType === "string"
  );
}

/**
 * Split an MCP tool result into its serialized `text` and any inline `images`,
 * replacing each image block's payload with a placeholder in the text so the
 * base64 data is delivered once, as an image, not duplicated in the transcript.
 *
 * @param data - the raw MCP result (expected to carry a `content` array).
 * @returns the text form and the extracted images; when there are no images the
 *   full result is serialized and `images` is empty.
 */
function extractMcpResult(data: unknown): { text: string; images: ToolResultImage[] } {
  const raw = (data as { content?: unknown }).content;
  if (!Array.isArray(raw)) return { text: safeStringify(data), images: [] };
  const content: unknown[] = raw;
  const images: ToolResultImage[] = [];
  for (const item of content) {
    if (isMcpImageBlock(item)) images.push({ data: item.data, mediaType: item.mimeType });
  }
  if (images.length === 0) return { text: safeStringify(data), images: [] };
  const stripped = {
    ...(data as object),
    content: content.map((item) =>
      isMcpImageBlock(item)
        ? { type: "image", mimeType: item.mimeType, data: "[image delivered as an image block]" }
        : item,
    ),
  };
  return { text: safeStringify(stripped), images };
}

/**
 * Inputs to {@link executeMcpToolCall}: the `call`, the {@link NamespacedRegistry}
 * that resolves wire names to connections, the `availableWireNames` for error
 * messages, the argument validator, the convergence `guards`, the trace sink,
 * the calling agent context, the `iteration`, and an optional abort `signal`.
 */
export interface McpDispatchArgs {
  call: LLMToolCall;
  registry: NamespacedRegistry;
  availableWireNames: string[];
  argValidator: ToolArgValidator;
  guards: ConvergenceGuards;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  signal?: AbortSignal;
}

/**
 * The `arguments_original` patch for a trace record, when a hook rewrote the call.
 *
 * @param call - the call as dispatched, carrying `rewrittenFrom` if replaced.
 * @returns a one-key patch, or an empty object when nothing was replaced.
 * @remarks `arguments` on the record stays what actually ran, because a trace
 *   entry records what the run did; this carries what the model asked for, so
 *   the two are comparable after the fact.
 */
function originalArgumentsPatch(call: LLMToolCall): { arguments_original?: object } {
  const from = call.rewrittenFrom;
  return typeof from === "object" && from !== null ? { arguments_original: from } : {};
}

/**
 * Dispatch a namespaced MCP tool call: resolve the wire name, validate the
 * arguments, invoke the tool (or a resource list/read), record the trace events,
 * and feed the convergence guards.
 *
 * @param args - the call and its registry/guard/trace context; see
 *   {@link McpDispatchArgs}.
 * @returns an {@link McpCallResult} with the result text, error text, productivity
 *   flag and any images.
 * @remarks Never throws for tool-level problems: an unknown name, a validation
 *   error or a failed call all resolve to an error result. The guard signature is
 *   recorded only when the run was not aborted. A `resource_list`/`resource_read`
 *   kind routes to the connection's resource methods instead of `callTool`.
 *
 *   A call whose arguments did not survive the provider round-trip is refused
 *   with {@link malformedArgumentsMessage} rather than dispatched with the
 *   substitute `{}`, its trace records the preview of what actually arrived, and
 *   its guard signature is built from that preview — otherwise every malformed
 *   call would read as the same call and the convergence guard would end the run
 *   faster than the bug it is reporting.
 */
export async function executeMcpToolCall(args: McpDispatchArgs): Promise<McpCallResult> {
  const {
    call,
    registry,
    availableWireNames,
    argValidator,
    guards,
    trace,
    agent,
    subagentInstanceId,
    iteration,
    signal,
  } = args;
  const toolStart = trace.now();
  const resolved = registry.resolve(call.name);
  const callId = call.id && call.id.length > 0 ? call.id : randomUUID();
  let resultText: string;
  let errText: string | null;
  let productive = false;
  let images: ToolResultImage[] = [];
  const tracedArguments =
    call.malformedArguments !== undefined
      ? { malformed_arguments: call.malformedArguments }
      : call.arguments;

  if (!resolved) {
    errText = `Unknown tool '${call.name}'. Available tools: ${availableWireNames.join(", ")}`;
    resultText = errText;
  } else if (call.malformedArguments !== undefined) {
    errText = malformedArgumentsMessage(call.name, {
      ok: false,
      preview: call.malformedArguments,
      reason: "unparsable",
    });
    resultText = errText;
  } else {
    const validationError = argValidator.validate(resolved.inputSchema, call.arguments, call.name);
    if (validationError !== null) {
      errText = validationError;
      resultText = errText;
      productive = false;
    } else {
      trace.record("tool_call_started", {
        agent,
        ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
        iteration_ref: iteration,
        call_id: callId,
        started_at: toolStart,
        name: resolved.fullName,
        arguments: tracedArguments,
      });
      const conn = resolved.connection;
      let result;
      if (resolved.kind === "resource_list" && conn.listResources) {
        result = await conn.listResources(signal);
      } else if (resolved.kind === "resource_read" && conn.readResource) {
        const uri = (call.arguments as { uri?: unknown }).uri;
        result = await conn.readResource(String(uri), signal);
      } else {
        result = await conn.callTool(resolved.toolName, call.arguments, signal);
      }
      if (result.ok) {
        const extracted = extractMcpResult(result.data);
        resultText = extracted.text;
        images = extracted.images;
        errText = null;
        productive = true;
      } else {
        errText = result.error?.message ?? "tool execution failed";
        resultText = errText;
        productive = result.error?.code !== "mcp_unavailable";
      }
    }
  }

  trace.record("tool_call", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration_ref: iteration,
    call_id: callId,
    started_at: toolStart,
    ended_at: trace.now(),
    name: resolved ? resolved.fullName : call.name,
    arguments: tracedArguments,
    ...originalArgumentsPatch(call),
    result: resultText,
    error: errText,
  });
  if (!signal?.aborted) {
    const sig =
      call.malformedArguments !== undefined
        ? `${call.name}:malformed:${call.malformedArguments}`
        : `${call.name}:${safeStringify(call.arguments)}`;
    guards.record(sig, resultText, errText !== null);
  }

  return { resultText, errText, productive, ...(images.length > 0 ? { images } : {}) };
}
