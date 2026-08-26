import type { RunSnapshot, ToolCallEvent, WorkspaceState } from "./types.ts";

import { contentToText, isBuiltinTraceEvent } from "@clarvis/capability";
import type { Message } from "@clarvis/capability";
import type { ExecutionRecord } from "@clarvis/capability";
import { truncate } from "./text.ts";

/** memory recommends result excerpts ≤ 2000 chars; the trace mapper
 * already truncated to 5000, so this re-truncates. */
const RESULT_EXCERPT_MAX = 2000;

/** The run's task is the FIRST user message (not the joined user text — later
 * user messages in a seeded conversation are follow-ups, not the task). */
export function firstUserText(messages: readonly Message[]): string {
  const first = messages.find((m) => m.role === "user");
  return first === undefined ? "" : contentToText(first.content);
}

function finalAnswerOf(record: ExecutionRecord): string | undefined {
  const response = record.response;
  if (response.status === "error") return undefined;
  const result = response.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return undefined;
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

/**
 * Map a persisted {@link ExecutionRecord} to the {@link RunSnapshot} memory's
 * indexer consumes.
 *
 * @param record - the run's stored record; its trace supplies the tool calls and
 *   steering messages, and its response supplies the final answer.
 * @param opts.workspace - workspace path recorded on the snapshot.
 * @param opts.workspaceState - optional captured VCS state (see
 *   {@link captureWorkspaceState}), included only when present.
 * @returns the snapshot: `task` from {@link firstUserText}, `final_answer` only
 *   for a non-error response, each `tool_call` with its result excerpt
 *   re-truncated to 2000 chars, and `steering` only when at least one steering
 *   message occurred.
 * @remarks A `tool_call` event with an empty `tool_name` is treated as an MCP
 *   call: its `mcp_name` becomes the tool name and `server` is omitted;
 *   otherwise `mcp_name` is carried as `server`. A capability-contributed event
 *   (narrowed away by {@link isBuiltinTraceEvent}) is never a `tool_call` or
 *   `user_steering` as the engine declares them, so it is skipped exactly like
 *   any other built-in kind this function does not read — memory's learning
 *   comes from what an agent *did*, not from a capability's own bookkeeping.
 *   Pure — no I/O. This is the host-side half of the mapping to `RunSnapshot`
 *   (memory spec §3.1); `@clarvis/memory` is a leaf and only declares the
 *   snapshot shape.
 */
export function storedExecutionToRunSnapshot(
  record: ExecutionRecord,
  opts: { workspace: string; workspaceState?: WorkspaceState },
): RunSnapshot {
  const toolCalls: ToolCallEvent[] = [];
  const steering: string[] = [];
  for (const event of record.trace.events) {
    if (!isBuiltinTraceEvent(event)) continue;
    if (event.type === "tool_call") {
      const namespaced = event.tool_name !== "";
      toolCalls.push({
        ...(event.call_id !== undefined ? { call_id: event.call_id } : {}),
        tool_name: namespaced ? event.tool_name : event.mcp_name,
        ...(namespaced ? { server: event.mcp_name } : {}),
        arguments: event.arguments,
        result_excerpt: truncate(event.result, RESULT_EXCERPT_MAX),
        error: event.error,
        started_at: event.started_at,
        ended_at: event.ended_at,
        ...(event.subagent_instance_id !== undefined
          ? { subagent: event.subagent_instance_id }
          : {}),
      });
    } else if (event.type === "user_steering") {
      steering.push(event.message);
    }
  }

  const finalAnswer = finalAnswerOf(record);
  return {
    run_id: record.id,
    workspace: opts.workspace,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.ended_at,
    task: firstUserText(record.request.messages),
    ...(finalAnswer !== undefined ? { final_answer: finalAnswer } : {}),
    tool_calls: toolCalls,
    ...(steering.length > 0 ? { steering } : {}),
    ...(opts.workspaceState !== undefined ? { workspace_state: opts.workspaceState } : {}),
  };
}
