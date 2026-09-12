import type { AgentRole } from "@clarvis/capability";
import { isBuiltinTraceEvent } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";

/**
 * Position of an event within its span's lifecycle: `start` opens a span, `end`
 * closes it, and `point` is a standalone marker that neither opens nor closes.
 */
export type SpanPhase = "start" | "end" | "point";

/**
 * The category of timeline span an event belongs to — the whole run, one loop
 * iteration, a sub-agent, a tool call, or a spanless one-off `event`.
 */
export type SpanKind = "run" | "iteration" | "subagent" | "tool" | "event";

/**
 * The span coordinates derived from a trace event: the grouping id, its
 * lifecycle {@link SpanPhase | phase}, and its {@link SpanKind | kind}.
 *
 * @remarks Produced by {@link deriveEventSpan}; consumers group events into
 *   timelines by matching {@link EventSpan.span_id | span_id}.
 */
export interface EventSpan {
  span_id: string;
  phase: SpanPhase;
  kind: SpanKind;
}

/**
 * Computes the stable span id for a loop iteration, keyed to the owning agent.
 *
 * @param agent - the agent role, or `undefined` when not a sub-agent context.
 * @param subagentInstanceId - the sub-agent instance id, required to scope a
 *   sub-agent iteration.
 * @param iteration - the iteration number within that agent's loop.
 * @returns `"<subagentInstanceId>:<iteration>"` for a sub-agent iteration, or
 *   `"lead:<iteration>"` for the lead (including when the instance id is absent).
 */
export function iterationSpanId(
  agent: AgentRole | undefined,
  subagentInstanceId: string | undefined,
  iteration: number,
): string {
  return agent === "subagent" && subagentInstanceId !== undefined
    ? `${subagentInstanceId}:${iteration}`
    : `lead:${iteration}`;
}

/**
 * Canonical TraceEvent → span derivation for trace consumers (timeline
 * grouping, wire metadata). Owns the mapping so downstream packages stop
 * re-deriving it: a scoped `compaction`/`cancellation` belongs to its
 * sub-agent's span (`subagent:<id>`), hence kind "subagent".
 *
 * @remarks Narrows with {@link isBuiltinTraceEvent} before switching, since a
 *   capability-contributed event's `type` is `string` and would otherwise match
 *   every `case`. A contributed event carries no span the engine can attribute
 *   it to, so it gets the same neutral treatment as the other run-level point
 *   events (`elicitation_requested`, `budget_check`, `soft_limit_check`,
 *   `mcp_degraded`): a `point` on the run's own timeline.
 */
export function deriveEventSpan(event: TraceEvent): EventSpan {
  if (!isBuiltinTraceEvent(event)) return { span_id: "run", phase: "point", kind: "event" };
  switch (event.type) {
    case "run_started":
      return { span_id: "run", phase: "start", kind: "run" };
    case "run_ended":
      return { span_id: "run", phase: "end", kind: "run" };
    case "lead_iteration_started":
      return {
        span_id: iterationSpanId("lead", undefined, event.iteration),
        phase: "start",
        kind: "iteration",
      };
    case "lead_iteration":
      return {
        span_id: iterationSpanId("lead", undefined, event.iteration),
        phase: "end",
        kind: "iteration",
      };
    case "subagent_iteration_started":
      return {
        span_id: iterationSpanId("subagent", event.subagent_instance_id, event.iteration),
        phase: "start",
        kind: "iteration",
      };
    case "subagent_iteration":
      return {
        span_id: iterationSpanId("subagent", event.subagent_instance_id, event.iteration),
        phase: "end",
        kind: "iteration",
      };
    case "delegation_created":
      return {
        span_id: `delegation:${event.delegation_id}`,
        phase: "start",
        kind: "subagent",
      };
    case "delegation_started":
      return {
        span_id: `delegation:${event.delegation_id}`,
        phase: "point",
        kind: "subagent",
      };
    case "delegation_completed":
    case "delegation_failed":
      return {
        span_id: `delegation:${event.delegation_id}`,
        phase: "end",
        kind: "subagent",
      };
    case "tool_call_started":
      return { span_id: event.call_id, phase: "start", kind: "tool" };
    case "tool_output_delta":
    case "tool_input_delta":
    case "tool_call_announced":
      return { span_id: event.call_id, phase: "point", kind: "tool" };
    case "tool_call":
      return {
        span_id: event.call_id ?? `${event.agent}:${event.iteration_ref}:tool`,
        phase: "end",
        kind: "tool",
      };
    case "model_reasoning":
    case "model_stream_delta":
    case "model_call_error":
    case "model_call_retry":
      return {
        span_id: iterationSpanId(event.agent, event.subagent_instance_id, event.iteration),
        phase: "point",
        kind: "iteration",
      };
    case "user_question":
    case "user_steering":
      return {
        span_id: iterationSpanId(event.agent, event.subagent_instance_id, event.iteration_ref),
        phase: "point",
        kind: "iteration",
      };
    case "compaction_started":
    case "compaction":
    case "compaction_skipped":
    case "cancellation":
    case "convergence_warning":
    case "guard_escalation":
      return event.subagent_instance_id !== undefined
        ? { span_id: `subagent:${event.subagent_instance_id}`, phase: "point", kind: "subagent" }
        : { span_id: "run", phase: "point", kind: "event" };
    case "elicitation_requested":
    case "budget_check":
    case "soft_limit_check":
    case "mcp_degraded":
    case "vision_analysis":
      return { span_id: "run", phase: "point", kind: "event" };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
