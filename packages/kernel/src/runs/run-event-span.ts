import type { AgentRole, RunEvent } from "@clarvis/protocol";

/** Whether a run event opens, closes, or is a point on a logical span. */
export type SpanPhase = "start" | "point" | "end";

/** Coarse span category for UI/timeline grouping. */
export type SpanKind = "run" | "iteration" | "subagent" | "tool" | "event";

/** Derived span identity for a protocol {@link RunEvent}. */
export interface RunEventSpan {
  /** Stable id of the logical span this event belongs to (e.g. `run`,
   * `lead:<n>`, `subagent:<id>`, or a tool `call_id`). */
  span_id: string;
  /** Whether the event opens, closes, or is a point on the span. */
  phase: SpanPhase;
  /** Coarse category the span groups under for timeline rendering. */
  kind: SpanKind;
}

/**
 * Stable span id for an agent iteration (`lead:N` or `<subagentId>:N`).
 *
 * A sub-agent event that arrives without its instance id is an upstream defect,
 * not a lead event: claiming `lead:N` for it would interleave its text with the
 * lead's own stream. It gets an isolated, deliberately non-colliding span so the
 * damage is a stray anonymous node instead of a scrambled transcript.
 */
export function iterationSpanId(
  agent: AgentRole | undefined,
  subagentId: string | undefined,
  iteration: number,
): string {
  if (agent !== "subagent") return `lead:${iteration}`;
  return subagentId !== undefined ? `${subagentId}:${iteration}` : `subagent-unknown:${iteration}`;
}

/**
 * Derives span metadata from a protocol run event for timelines and nesting.
 *
 * @param ev - the protocol event to place on a span.
 * @returns the event's {@link RunEventSpan}: run start/end frame the `run` span,
 *   iteration and tool events open/point/close their own spans, delegation
 *   events map to a `subagent:<delegation_id>` span, and standalone notices
 *   (elicitation, plan, memory, limits, ...) are `point`s on the `run` span. A
 *   tool-completed event with no `call_id` falls back to `<agent>:tool`.
 * @remarks The `default` branch is a compile-time exhaustiveness guard over the
 *   {@link RunEvent} union; an unhandled type is a type error, not a runtime path.
 */
export function deriveRunEventSpan(ev: RunEvent): RunEventSpan {
  switch (ev.type) {
    case "run_started":
      return { span_id: "run", phase: "start", kind: "run" };
    case "run_ended":
      return { span_id: "run", phase: "end", kind: "run" };

    case "iteration_started":
      return {
        span_id: iterationSpanId(ev.agent, ev.subagent_id, ev.iteration),
        phase: "start",
        kind: "iteration",
      };
    case "iteration_completed":
      return {
        span_id: iterationSpanId(ev.agent, ev.subagent_id, ev.iteration),
        phase: "end",
        kind: "iteration",
      };

    case "delegation_created":
      return { span_id: `subagent:${ev.delegation_id}`, phase: "start", kind: "subagent" };
    case "delegation_started":
      return { span_id: `subagent:${ev.delegation_id}`, phase: "point", kind: "subagent" };
    case "delegation_completed":
    case "delegation_failed":
      return { span_id: `subagent:${ev.delegation_id}`, phase: "end", kind: "subagent" };

    case "workflow_run_started":
      return { span_id: `workflow:${ev.run_id}`, phase: "start", kind: "subagent" };
    case "workflow_title_updated":
      return { span_id: `workflow:${ev.run_id}`, phase: "point", kind: "event" };
    case "workflow_sequence_state":
      return { span_id: `workflow:${ev.run_id}`, phase: "point", kind: "event" };
    case "workflow_run_completed":
    case "workflow_run_failed":
      return { span_id: `workflow:${ev.run_id}`, phase: "end", kind: "subagent" };
    case "workflow_run_progress":
      return { span_id: `workflow:${ev.run_id}`, phase: "point", kind: "subagent" };

    case "tool_call_started":
      return { span_id: ev.call_id, phase: "start", kind: "tool" };
    case "tool_output_delta":
    case "tool_input_delta":
      return { span_id: ev.call_id, phase: "point", kind: "tool" };
    case "tool_call":
      return { span_id: ev.call_id ?? `${ev.agent}:tool`, phase: "end", kind: "tool" };

    case "reasoning":
    case "text_delta":
    case "model_error":
    case "model_retry":
      return {
        span_id: iterationSpanId(ev.agent, ev.subagent_id, ev.iteration),
        phase: "point",
        kind: "iteration",
      };

    case "steering_applied":
      return {
        span_id: ev.subagent_id !== undefined ? `subagent:${ev.subagent_id}` : "run",
        phase: "point",
        kind: "iteration",
      };

    case "compaction_started":
    case "compaction":
    case "compaction_skipped":
      return ev.subagent_id !== undefined
        ? { span_id: `subagent:${ev.subagent_id}`, phase: "point", kind: "subagent" }
        : { span_id: "run", phase: "point", kind: "event" };

    case "vision_analysis":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "soft_limit_check":
    case "plan_created":
    case "plan_updated":
    case "plan_removed":
    case "plan_review_requested":
    case "plan_review_resolved":
    case "mcp_degraded":
    case "memory_ingest":
    case "capability_event":
    case "events_dropped":
      return { span_id: "run", phase: "point", kind: "event" };

    default: {
      const exhaustive: never = ev;
      return exhaustive;
    }
  }
}
