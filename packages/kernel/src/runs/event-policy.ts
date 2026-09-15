import type { RunEvent } from "@clarvis/protocol";

/** Origin of a protocol run event before projection. */
export type RunEventSource = "engine_trace" | "capability_channel" | "kernel_derived" | "workflow";

/** Replay behavior of one protocol run event. */
export type RunEventDurability = "persisted" | "live_only";

/** Mapper responsible for projecting an event source. */
export type RunEventMapper = "engine" | "capability" | "managed_run" | "workflow";

/** Exhaustive lifecycle and backpressure policy for one run-event variant. */
export interface RunEventPolicy {
  /** All channels capable of producing this event. */
  readonly sources: readonly RunEventSource[];
  /** Whether session restoration reproduces the event. */
  readonly durability: RunEventDurability;
  /** Projection path responsible for the event. */
  readonly mapper: RunEventMapper;
  /** Lossless adjacent coalescing class, if any. */
  readonly coalesce: "text_delta" | "tool_output_delta" | "tool_input_delta" | false;
  /** Whether a full live buffer may discard the event. */
  readonly droppable: boolean;
}

const persisted = (
  mapper: RunEventMapper = "engine",
  sources: readonly RunEventSource[] = ["engine_trace"],
): RunEventPolicy => ({
  sources,
  durability: "persisted",
  mapper,
  coalesce: false,
  droppable: false,
});

const live = (
  mapper: RunEventMapper,
  sources: readonly RunEventSource[],
  coalesce: RunEventPolicy["coalesce"] = false,
  droppable = false,
): RunEventPolicy => ({
  sources,
  durability: "live_only",
  mapper,
  coalesce,
  droppable,
});

/**
 * Exhaustive source, durability, mapping, and backpressure registry.
 *
 * @remarks `satisfies Record<RunEvent["type"], ...>` makes every protocol event
 * addition fail compilation until its replay and drop behavior is classified.
 */
export const RUN_EVENT_POLICY = {
  run_started: persisted(),
  run_ended: persisted(),
  iteration_started: persisted(),
  iteration_completed: persisted(),
  tool_call_started: persisted(),
  tool_call_announced: persisted(),
  tool_call: persisted(),
  tool_output_delta: live("engine", ["engine_trace"], "tool_output_delta", true),
  tool_input_delta: live("engine", ["engine_trace"], "tool_input_delta", true),
  reasoning: persisted(),
  text_delta: live("engine", ["engine_trace"], "text_delta", true),
  model_error: persisted(),
  model_retry: persisted(),
  delegation_created: persisted("engine", ["engine_trace", "capability_channel"]),
  delegation_started: persisted("engine", ["engine_trace", "capability_channel"]),
  delegation_completed: persisted("engine", ["engine_trace", "capability_channel"]),
  delegation_failed: persisted("engine", ["engine_trace", "capability_channel"]),
  workflow_run_started: persisted("engine", ["engine_trace", "workflow"]),
  workflow_title_updated: live("workflow", ["workflow"]),
  workflow_sequence_state: live("workflow", ["workflow"]),
  workflow_run_progress: live("workflow", ["workflow"]),
  workflow_run_completed: persisted("engine", ["engine_trace", "workflow"]),
  workflow_run_failed: persisted("engine", ["engine_trace", "workflow"]),
  plan_created: live("capability", ["capability_channel"]),
  plan_updated: live("capability", ["capability_channel"]),
  plan_removed: live("capability", ["capability_channel"]),
  plan_review_requested: live("capability", ["capability_channel"]),
  plan_review_resolved: live("capability", ["capability_channel"]),
  soft_limit_check: persisted(),
  compaction_started: live("engine", ["engine_trace"]),
  compaction: persisted(),
  compaction_skipped: persisted(),
  vision_analysis: persisted(),
  elicitation_requested: persisted(),
  elicitation_resolved: persisted(),
  steering_applied: persisted(),
  memory_ingest: live("capability", ["capability_channel"]),
  capability_event: live("capability", ["capability_channel"]),
  events_dropped: live("managed_run", ["kernel_derived"]),
  mcp_degraded: persisted(),
} as const satisfies Record<RunEvent["type"], RunEventPolicy>;
