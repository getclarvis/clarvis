import { coalesceRunEvents, RUN_EVENT_POLICY } from "@clarvis/kernel/policy";
import type { RunEvent } from "@clarvis/protocol";

/** MCP logging levels this facade emits. */
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

/** Ascending severity rank for each {@link LogLevel}, used by {@link meetsThreshold}. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
};

/** Every MCP logging level, in ascending severity, for `logging/setLevel`. */
const ALL_LEVELS: readonly string[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

/** Whether `level` is at or above the session's configured `threshold`. */
export function meetsThreshold(level: LogLevel, threshold: string): boolean {
  const idx = ALL_LEVELS.indexOf(threshold);
  const floor = idx === -1 ? LEVEL_RANK.info : Math.min(idx, LEVEL_RANK.error);
  return LEVEL_RANK[level] >= floor;
}

/** How one run event is presented on the notification channels. */
export interface EventView {
  level: LogLevel;
  logger: string;
  /** Short human label for a progress notification. */
  label: string;
}

/**
 * Project a run event onto its presentation.
 *
 * @param event - the streamed event.
 * @returns the level, logger name and progress label.
 */
export function viewOf(event: RunEvent): EventView {
  switch (event.type) {
    case "run_started":
      return { level: "info", logger: "clarvis.run", label: "run started" };
    case "run_ended":
      return { level: "info", logger: "clarvis.run", label: `run ${event.status}` };
    case "iteration_started":
      return { level: "debug", logger: "clarvis.iteration", label: `iteration ${event.iteration}` };
    case "iteration_completed":
      return {
        level: "debug",
        logger: "clarvis.iteration",
        label: `iteration ${event.iteration} done`,
      };
    case "tool_call_started":
      return { level: "info", logger: "clarvis.tool", label: `${event.server}.${event.tool}` };
    case "tool_call":
      return {
        level: event.ok ? "info" : "warning",
        logger: "clarvis.tool",
        label: `${event.server}.${event.tool} ${event.ok ? "ok" : "failed"}`,
      };
    case "tool_output_delta":
      return { level: "debug", logger: "clarvis.tool", label: "tool output" };
    case "tool_input_delta":
      return { level: "debug", logger: "clarvis.tool", label: `composing ${event.tool}` };
    case "text_delta":
      return { level: "debug", logger: "clarvis.text", label: "generating" };
    case "reasoning":
      return { level: "debug", logger: "clarvis.text", label: "reasoning" };
    case "model_error":
      return { level: "warning", logger: "clarvis.model", label: `model error: ${event.kind}` };
    case "model_retry":
      return {
        level: "info",
        logger: "clarvis.model",
        label: `retrying in ${Math.round(event.delay_ms / 1000)}s (${event.attempt}/${event.max_retries})`,
      };
    case "delegation_created":
    case "delegation_started":
      return { level: "info", logger: "clarvis.delegation", label: "sub-agent started" };
    case "delegation_completed":
    case "delegation_failed":
      return { level: "info", logger: "clarvis.delegation", label: `sub-agent ${event.status}` };
    case "workflow_run_started":
      return { level: "info", logger: "clarvis.workflow", label: "leader started" };
    case "workflow_title_updated":
      return { level: "debug", logger: "clarvis.workflow", label: "workflow titled" };
    case "workflow_run_completed":
    case "workflow_run_failed":
      return { level: "info", logger: "clarvis.workflow", label: `leader ${event.status}` };
    case "workflow_run_progress":
      return { level: "debug", logger: "clarvis.workflow", label: "leader progress" };
    case "plan_created":
      return { level: "info", logger: "clarvis.plan", label: `plan: ${event.title}` };
    case "plan_updated":
      return { level: "info", logger: "clarvis.plan", label: "plan updated" };
    case "plan_removed":
      return { level: "info", logger: "clarvis.plan", label: "plan removed" };
    case "plan_review_requested":
      return { level: "notice", logger: "clarvis.plan", label: "plan awaiting review" };
    case "plan_review_resolved":
      return { level: "info", logger: "clarvis.plan", label: `plan ${event.outcome}` };
    case "elicitation_requested":
      return { level: "notice", logger: "clarvis.elicit", label: "question asked" };
    case "elicitation_resolved":
      return { level: "info", logger: "clarvis.elicit", label: `question ${event.outcome}` };
    case "soft_limit_check":
      return { level: "notice", logger: "clarvis.budget", label: `${event.dimension} limit` };
    case "compaction_started":
      return { level: "info", logger: "clarvis.context", label: "context compaction started" };
    case "compaction":
      return { level: "debug", logger: "clarvis.context", label: "context compacted" };
    case "compaction_skipped":
      return {
        level: "warning",
        logger: "clarvis.context",
        label: `context compaction skipped: ${event.reason}`,
      };
    case "vision_analysis":
      return {
        level: event.status === "completed" ? "info" : "warning",
        logger: "clarvis.vision",
        label:
          event.status === "completed"
            ? `read ${String(event.image_count)} image(s)`
            : "image reading failed",
      };
    case "steering_applied":
      return { level: "info", logger: "clarvis.run", label: "steering applied" };
    case "memory_ingest":
      return { level: "debug", logger: "clarvis.memory", label: "memory indexed" };
    case "capability_event":
      return {
        level: "debug",
        logger: `clarvis.capability.${event.capability}`,
        label: event.projection,
      };
    case "events_dropped":
      return { level: "warning", logger: "clarvis.stream", label: "events dropped" };
    case "mcp_degraded":
      return { level: "warning", logger: "clarvis.mcp", label: "mcp server degraded" };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * The key under which an event may merge into the buffer tail, or `undefined`
 * when it must stay separate.
 *
 * @remarks Which event types are eligible is read from kernel's
 * {@link RUN_EVENT_POLICY} rather than re-listed here; only the three live delta
 * variants currently coalesce, and only within one agent, iteration and
 * channel (or one tool call).
 */
export function mergeKeyOf(event: RunEvent): string | undefined {
  if (RUN_EVENT_POLICY[event.type].coalesce === false) return undefined;
  if (event.type === "text_delta") {
    if (event.reset) return undefined;
    return `t:${event.agent}:${event.subagent_id ?? ""}:${event.iteration}:${event.channel}`;
  }
  if (event.type === "tool_output_delta") {
    return `o:${event.agent}:${event.subagent_id ?? ""}:${event.call_id}`;
  }
  if (event.type === "tool_input_delta") {
    return `i:${event.agent}:${event.subagent_id ?? ""}:${event.call_id}`;
  }
  return undefined;
}

/** Merge one compatible pair for callers that need an eager event value. */
export function mergeEvents(prev: RunEvent, next: RunEvent): RunEvent {
  return coalesceRunEvents(prev, next) ?? next;
}
