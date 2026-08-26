import { randomUUID } from "node:crypto";
import type { LLMToolCall } from "./llm-port.ts";
import type { TracePort } from "./ports.ts";
import type { AgentRole } from "./api.ts";
import type { ToolArgValidate } from "./loop-contract.ts";

/**
 * Inputs to {@link openCallEnvelope}: the raw `call`, the tool's display `name`,
 * the trace sink, the calling `agent` (and optional `subagentInstanceId`), the
 * `iteration`, and an optional JSON `schema` to validate the arguments against.
 *
 * @remarks `schema` and `validate` are a pair: supplying a schema with no
 *   validator is a construction error, not a silently valid call. See
 *   {@link openCallEnvelope}.
 */
export interface CallEnvelopeArgs {
  call: LLMToolCall;
  name: string;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  schema?: Record<string, unknown>;
  /** Validates `call.arguments` against `schema`; normally
   * `AgentBuildContext.validateArgs`, projected onto a handler's base. */
  validate?: ToolArgValidate;
  /** Safe argument projection persisted in trace instead of the raw model payload. */
  traceArguments?: unknown;
}

/**
 * A per-call helper that owns a tool call's trace lifecycle and result framing:
 * the resolved `callId`, the `invalid` argument-validation message (or `null`),
 * and the `start`/`ok`/`fail` recorders.
 *
 * @remarks `ok` and `fail` both emit the terminal `tool_call` trace event and
 *   return the model-facing result string; `fail` additionally records the
 *   message as the call's error.
 */
export interface CallEnvelope {
  callId: string;
  invalid: string | null;
  start(): void;
  /** `traceResult` lets a sensitive tool return rich model text while persisting only metadata. */
  ok(result: string, traceResult?: string): string;
  /** `traceMessage` is the redacted diagnostic persisted for a sensitive failure. */
  fail(message: string, traceMessage?: string): string;
}

/**
 * Open a {@link CallEnvelope} for one tool call: resolve its call id, validate
 * its arguments against the optional `schema`, and return the trace/result
 * recorders shared by the built-in single-tool handlers (`ask_user`,
 * `load_skill`, …).
 *
 * @param a - the call, tool name, trace, agent context and optional
 *   schema/validator pair.
 * @returns a {@link CallEnvelope}; when `invalid` is non-`null` the caller should
 *   short-circuit via `fail(invalid)` without emitting a `start`.
 * @throws Error when `schema` is supplied without `validate`. This package
 *   carries no JSON Schema implementation — the engine owns one and injects it
 *   through `AgentBuildContext.validateArgs` — so the alternative to
 *   throwing is reporting every malformed call as valid, which is a validation
 *   boundary failing open in silence.
 * @remarks The call id falls back to a fresh UUID when the provider supplied
 *   none.
 */
export function openCallEnvelope(a: CallEnvelopeArgs): CallEnvelope {
  if (a.schema !== undefined && a.validate === undefined) {
    throw new Error(
      `openCallEnvelope: tool '${a.name}' supplied an argument schema with no validator. ` +
        "Pass the run's 'validateArgs' port alongside 'schema'.",
    );
  }
  const startedAt = a.trace.now();
  const callId = a.call.id && a.call.id.length > 0 ? a.call.id : randomUUID();
  const idFields =
    a.subagentInstanceId !== undefined ? { subagent_instance_id: a.subagentInstanceId } : {};
  const invalid =
    a.schema === undefined ? null : (a.validate?.(a.schema, a.call.arguments) ?? null);
  const record = (result: string, error: string | null): void => {
    a.trace.record("tool_call", {
      agent: a.agent,
      ...idFields,
      iteration_ref: a.iteration,
      call_id: callId,
      started_at: startedAt,
      ended_at: a.trace.now(),
      name: a.name,
      arguments: a.traceArguments ?? a.call.arguments ?? {},
      result,
      error,
    });
  };
  return {
    callId,
    invalid,
    start(): void {
      a.trace.record("tool_call_started", {
        agent: a.agent,
        ...idFields,
        iteration_ref: a.iteration,
        call_id: callId,
        started_at: startedAt,
        name: a.name,
        arguments: a.traceArguments ?? a.call.arguments ?? {},
      });
    },
    ok(result: string, traceResult = result): string {
      record(traceResult, null);
      return `Tool '${a.name}' result: ${result}`;
    },
    fail(message: string, traceMessage = message): string {
      record(traceMessage, traceMessage);
      return `Tool '${a.name}' result (error): ${message}`;
    },
  };
}
