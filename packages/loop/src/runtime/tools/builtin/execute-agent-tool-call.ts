import { randomUUID } from "node:crypto";
import { malformedArgumentsMessage } from "@clarvis/capability";
import type { LLMToolCall, ToolInvocationControl, TracePort } from "@clarvis/capability";
import { wasOperatorInterrupted } from "../tool-interrupt.ts";
import type { ConvergenceGuards } from "../../guards/convergence-guards.ts";
import type { AgentRole } from "@clarvis/capability";
import { safeStringify } from "../../support/stringify.ts";
import type { ToolResultImage } from "@clarvis/capability";
import type { AgentToolset } from "./toolset.ts";

/**
 * The outcome of dispatching one coding-tool call: the model-facing `resultText`,
 * the `errText` (or `null` on success), whether it was `productive`, and any
 * `images` produced (e.g. a `read_image`).
 */
export interface AgentToolCallResult {
  resultText: string;
  errText: string | null;
  productive: boolean;
  images?: ToolResultImage[];
}

/**
 * Inputs to {@link executeAgentToolCall}: the `call`, the {@link AgentToolset}
 * that runs it, the convergence `guards`, the trace sink, the calling agent
 * context, the `iteration`, and an optional abort `signal`.
 */
export interface AgentToolDispatchArgs {
  call: LLMToolCall;
  toolset: AgentToolset;
  guards: ConvergenceGuards;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  signal?: AbortSignal;
  /** Run-only abort; used to distinguish global cancel from a selective interrupt. */
  runSignal?: AbortSignal;
  /** Live operator control published on `tool_call_started` when present. */
  control?: ToolInvocationControl;
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
 * Dispatch one built-in coding-tool call through the {@link AgentToolset}: record
 * the start/streamed-output/terminal trace events, run the tool, and feed the
 * convergence guards.
 *
 * @param args - the call and its toolset/guard/trace context; see
 *   {@link AgentToolDispatchArgs}.
 * @returns an {@link AgentToolCallResult}; a tool error is carried as `errText`
 *   with `productive` false, not thrown.
 * @remarks Streamed tool output is relayed as `tool_output_delta` trace signals.
 *   Any `diff` the tool returns is attached to the terminal `tool_call` event.
 *   The guard signature is recorded only when the run was not aborted.
 */
export async function executeAgentToolCall(
  args: AgentToolDispatchArgs,
): Promise<AgentToolCallResult> {
  const {
    call,
    toolset,
    guards,
    trace,
    agent,
    subagentInstanceId,
    iteration,
    signal,
    runSignal,
    control,
  } = args;
  const startedControl =
    control === undefined
      ? {}
      : {
          control: {
            tool_execution_id: control.toolExecutionId,
            actions: control.actions,
          },
        };
  const toolStart = trace.now();
  const callId = call.id && call.id.length > 0 ? call.id : randomUUID();
  const tracedArguments =
    call.malformedArguments !== undefined
      ? { malformed_arguments: call.malformedArguments }
      : call.arguments;

  if (call.malformedArguments !== undefined) {
    const errText = malformedArgumentsMessage(call.name, {
      ok: false,
      preview: call.malformedArguments,
      reason: "unparsable",
    });
    trace.record("tool_call", {
      agent,
      ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
      iteration_ref: iteration,
      call_id: callId,
      started_at: toolStart,
      ended_at: trace.now(),
      name: call.name,
      arguments: tracedArguments,
      result: errText,
      error: errText,
    });
    if (!signal?.aborted) {
      guards.record(`${call.name}:malformed:${call.malformedArguments}`, errText, true);
    }
    return { resultText: errText, errText, productive: false };
  }

  const callArgs = call.arguments as Record<string, unknown>;

  let terminal = false;
  let started = false;
  const recordStarted = (): void => {
    if (terminal || started || signal?.aborted || runSignal?.aborted) return;
    started = true;
    trace.record("tool_call_started", {
      agent,
      ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
      iteration_ref: iteration,
      call_id: callId,
      started_at: toolStart,
      name: call.name,
      arguments: tracedArguments,
      ...startedControl,
    });
  };

  if (control === undefined) recordStarted();

  const onOutput = (chunk: string): void => {
    if (terminal || runSignal?.aborted) return;
    trace.signal("tool_output_delta", {
      agent,
      ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
      call_id: callId,
      chunk,
    });
  };

  const { isError, text, images, diff, guard, abortUnsettled, executionAborted } =
    await toolset.dispatch(
      call.name,
      callArgs,
      signal,
      onOutput,
      control === undefined ? undefined : recordStarted,
      runSignal,
    );
  terminal = true;
  const interrupted =
    executionAborted === true &&
    !abortUnsettled &&
    wasOperatorInterrupted(runSignal ?? signal, signal);
  const resultText = interrupted ? `Shell interrupted by the operator.\n${text}` : text;
  const errText = interrupted || isError ? resultText : null;
  const productive = !isError && !interrupted;

  trace.record("tool_call", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration_ref: iteration,
    call_id: callId,
    started_at: toolStart,
    ended_at: trace.now(),
    name: call.name,
    arguments: tracedArguments,
    ...originalArgumentsPatch(call),
    result: resultText,
    error: errText,
    ...(diff !== undefined ? { diff } : {}),
    ...(guard !== undefined ? { guard } : {}),
    ...(interrupted ? { interruption: { source: "operator" as const } } : {}),
  });

  if (!signal?.aborted) {
    guards.record(
      `${call.name}:${safeStringify(call.arguments)}`,
      text,
      guard?.outcome === "denied" ? "denied" : errText !== null,
    );
  }

  return { resultText, errText, productive, ...(images ? { images } : {}) };
}
