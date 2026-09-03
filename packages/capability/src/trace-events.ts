import type { RunRequest, AgentRole, AssistantMessagePhase, ToolTransport } from "./api.ts";
import type {
  ContextSnapshotEntry,
  ErrorCode,
  ExecutionMode,
  FailureKind,
  RunEndedReason,
  RunResponse,
} from "./run.ts";
import type { ExecutionStatus } from "./execution-status.ts";
import type { CommandGuardReview } from "./trace-kinds.ts";

/**
 * The public, persisted shape of a single loop event: a flat discriminated union
 * keyed by `type`, with all timestamps as absolute Unix-epoch milliseconds.
 *
 * @remarks This is the wire/storage projection of the engine's internal
 *   {@link import("./trace-kinds.ts").TraceEntry | TraceEntry} (which uses
 *   run-relative offsets and a nested `{ at, kind, detail }` envelope);
 *   `mapEntry` in `persistence/trace-mapper.ts` flattens and rebases entries into
 *   these events, splitting the tool `name` into `mcp_name`/`tool_name` and
 *   truncating free-text fields. The two `*_started` and `*_delta` variants are
 *   live-only progress signals and are not persisted — the corresponding
 *   completed variant (`lead_iteration`, `subagent_iteration`, `tool_call`,
 *   `model_reasoning`) is the authoritative record. `iteration_ref` on tool and
 *   user events points back at the iteration that produced them; a defined
 *   `subagent_instance_id` scopes the event to a sub-agent, otherwise it belongs
 *   to the lead.
 */
export type BuiltinTraceEvent =
  | {
      type: "lead_iteration";
      iteration: number;
      started_at: number;
      ended_at: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
      cache_read_ratio: number;
      response: string;
      response_phase?: AssistantMessagePhase;
    }
  | {
      type: "delegation_created";
      delegation_id: string;
      spawned_at: number;
      title: string;
      task: string;
      tools: string[];
      task_id?: string;
      profile?: string;
    }
  | {
      type: "subagent_iteration";
      subagent_instance_id: string;
      iteration: number;
      started_at: number;
      ended_at: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
      cache_read_ratio: number;
      response: string;
      response_phase?: AssistantMessagePhase;
    }
  | {
      type: "tool_call";
      agent: AgentRole;
      subagent_instance_id?: string;
      call_id?: string;
      iteration_ref: number;
      started_at: number;
      ended_at: number;
      mcp_name: string;
      tool_name: string;
      arguments: object;
      /**
       * What the model asked for, when a hook rewrote the call before it ran.
       *
       * @remarks Present only then, so its presence is the flag. `arguments`
       *   stays what actually executed, because a trace entry records what the
       *   run did; this carries what it was asked to do, so the two can be
       *   compared. The model's own context is unaffected either way — a
       *   continuation restores from the persisted `final_context`, never from
       *   these events.
       */
      arguments_original?: object;
      result: string;
      error: string | null;
      diff?: string;
      guard?: CommandGuardReview;
    }
  | {
      type: "tool_call_started";
      agent: AgentRole;
      subagent_instance_id?: string;
      call_id: string;
      iteration_ref: number;
      started_at: number;
      mcp_name: string;
      tool_name: string;
      arguments: object;
    }
  | {
      type: "tool_output_delta";
      agent: AgentRole;
      subagent_instance_id?: string;
      call_id: string;
      occurred_at: number;
      chunk: string;
    }
  | {
      type: "tool_input_delta";
      agent: AgentRole;
      subagent_instance_id?: string;
      call_id: string;
      occurred_at: number;
      tool_name: string;
      chars: number;
      stream_chars?: number;
      complete?: true;
    }
  | {
      type: "subagent_iteration_started";
      subagent_instance_id: string;
      iteration: number;
      started_at: number;
      model: string;
    }
  | {
      type: "lead_iteration_started";
      iteration: number;
      started_at: number;
      model: string;
    }
  | {
      type: "delegation_completed";
      delegation_id: string;
      task_id?: string;
      completed_at: number;
      status: string;
      result: string;
    }
  | {
      type: "delegation_failed";
      delegation_id: string;
      task_id?: string;
      completed_at: number;
      status: string;
      result: string;
    }
  | {
      type: "budget_check";
      checked_at: number;
      tokens_used: number;
      tokens_remaining?: number;
    }
  | {
      type: "compaction_started";
      agent: AgentRole;
      subagent_instance_id?: string;
      mode: "scheduled" | "forced";
      occurred_at: number;
    }
  | {
      type: "compaction";
      agent: AgentRole;
      subagent_instance_id?: string;
      operation: "eviction" | "truncation" | "summarization";
      fallback_reason?: "summarization_failed" | "summary_not_effective";
      occurred_at: number;
      evicted_count?: number;
      freed_chars?: number;
      original_chars?: number;
      kept_chars?: number;
      anchor_chars?: number;
      anchor_updated?: boolean;
      contribution_count?: number;
      requested?: true;
      user_contribution_count?: number;
      task_id?: string;
    }
  | {
      type: "vision_analysis";
      model: string;
      image_count: number;
      status: "completed" | "failed";
      result: string;
      occurred_at: number;
    }
  | {
      type: "compaction_skipped";
      agent: AgentRole;
      subagent_instance_id?: string;
      occurred_at: number;
      reason:
        | "disabled"
        | "nothing_to_compact"
        | "summarization_disabled"
        | "summarization_failed"
        | "summary_not_effective";
    }
  | {
      type: "cancellation";
      agent: AgentRole;
      subagent_instance_id?: string;
      occurred_at: number;
      reason?: string;
    }
  | {
      type: "user_question";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration_ref: number;
      occurred_at: number;
      question: string;
      outcome: "accept" | "decline" | "cancel";
      answer?: string;
      options?: string[];
    }
  | {
      type: "user_steering";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration_ref: number;
      occurred_at: number;
      message: string;
      id?: string;
    }
  | {
      type: "soft_limit_check";
      agent: AgentRole;
      occurred_at: number;
      dimension: "tokens" | "iterations";
      used: number;
      limit: number;
      outcome: "continued" | "declined" | "no_response" | "escalations_exhausted";
      new_checkpoint?: number;
      escalations: number;
    }
  | {
      type: "run_started";
      occurred_at: number;
      mode: ExecutionMode;
      lead_model?: string;
      subagent_model?: string;
      max_tokens?: number;
    }
  | {
      type: "run_ended";
      occurred_at: number;
      reason: RunEndedReason;
      code?: ErrorCode;
    }
  | {
      type: "delegation_started";
      delegation_id: string;
      task_id?: string;
      occurred_at: number;
      model: string;
    }
  | {
      type: "model_call_error";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration: number;
      occurred_at: number;
      model: string;
      kind: FailureKind;
      message: string;
      status?: number;
      retry_after_ms?: number;
      /** Whether the failed attempts' tokens could be read and charged. */
      usage_attributed?: boolean;
    }
  | {
      /**
       * A hard convergence-guard trip put to the user, and their decision.
       *
       * @remarks Persisted for the same reason `soft_limit_check` is: when a run
       * keeps spending past a limit it was going to die at, the record must show
       * that a human authorized it, and how many times.
       */
      type: "guard_escalation";
      agent: AgentRole;
      subagent_instance_id?: string;
      occurred_at: number;
      code: "tool_failure_loop" | "stagnation_detected";
      outcome: "continued" | "declined" | "no_response" | "escalations_exhausted";
      escalations: number;
    }
  | {
      /**
       * A convergence guard crossed its soft tier and the model was warned.
       *
       * @remarks Persisted so the record shows the warning a later `terminate`
       * gave first — and, when the model changed course, that the warning
       * worked. It has no protocol projection yet: the human-facing surface for
       * near-limit warnings is a separate decision from recording them.
       */
      type: "convergence_warning";
      agent: AgentRole;
      subagent_instance_id?: string;
      occurred_at: number;
      code: "tool_failure_loop" | "stagnation_detected";
      message: string;
    }
  | {
      type: "model_call_retry";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration: number;
      occurred_at: number;
      model: string;
      kind: FailureKind;
      message: string;
      status?: number;
      retry_after_ms?: number;
      attempt: number;
      max_retries: number;
      delay_ms: number;
    }
  | {
      type: "elicitation_requested";
      agent?: AgentRole;
      subagent_instance_id?: string;
      iteration_ref?: number;
      occurred_at: number;
      source: "ask_user" | "tool_relay";
      question: string;
      options?: string[];
    }
  | {
      type: "model_reasoning";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration: number;
      occurred_at: number;
      model: string;
      text: string;
    }
  | {
      type: "model_stream_delta";
      agent: AgentRole;
      subagent_instance_id?: string;
      iteration: number;
      occurred_at: number;
      model: string;
      channel: "text" | "reasoning";
      text: string;
      reset: boolean;
    }
  | {
      type: "mcp_degraded";
      occurred_at: number;
      servers: { name: string; transport: ToolTransport; reason: string }[];
    };

/**
 * An ordered, persisted sequence of loop {@link TraceEvent}s — the durable,
 * absolute-time projection replayed to rehydrate a run for a client.
 */
export interface Trace {
  events: TraceEvent[];
}

/**
 * Re-exported so consumers of the trace types get the run's terminal
 * {@link ExecutionStatus} vocabulary (`completed`, `budget_exhausted`, `error`,
 * `cancelled`, `soft_limit_declined`) from one module.
 */
export type { ExecutionStatus };

/**
 * The complete persisted record of one finished run: request, response, full
 * {@link Trace}, token totals, and optional carry-over context — the unit a
 * trace store inserts and reads back.
 *
 * @remarks Timestamps here are absolute Unix-epoch milliseconds (numbers), and
 *   `total_*_tokens` aggregate the whole run (lead plus sub-agents).
 *   `final_context` holds the surviving context entries a follow-up run resumes
 *   from; `plan_ref` names the plan file this run drove, if any.
 */
/**
 * Every {@link BuiltinTraceEvent} discriminator, as a runtime list.
 *
 * @remarks The counterpart of {@link BUILTIN_TRACE_KINDS} on the *mapped* side:
 *   it is what {@link isBuiltinTraceEvent} tests against, and the drift lock
 *   below pins it to the union it describes.
 */
export const BUILTIN_TRACE_EVENT_TYPES = [
  "lead_iteration",
  "delegation_created",
  "subagent_iteration",
  "tool_call",
  "tool_call_started",
  "tool_output_delta",
  "tool_input_delta",
  "subagent_iteration_started",
  "lead_iteration_started",
  "delegation_completed",
  "delegation_failed",
  "budget_check",
  "compaction_started",
  "compaction",
  "compaction_skipped",
  "vision_analysis",
  "cancellation",
  "user_question",
  "user_steering",
  "soft_limit_check",
  "run_started",
  "run_ended",
  "delegation_started",
  "model_call_error",
  "guard_escalation",
  "convergence_warning",
  "model_call_retry",
  "elicitation_requested",
  "model_reasoning",
  "model_stream_delta",
  "mcp_degraded",
] as const;

/**
 * Compile-time drift locks pinning {@link BUILTIN_TRACE_EVENT_TYPES} to exactly
 * the discriminators of {@link BuiltinTraceEvent}, in both directions.
 */
const _everyEventTypeIsListed: [
  Exclude<BuiltinTraceEvent["type"], (typeof BUILTIN_TRACE_EVENT_TYPES)[number]>,
] extends [never]
  ? true
  : false = true;
const _everyListedTypeIsAnEvent: [
  Exclude<(typeof BUILTIN_TRACE_EVENT_TYPES)[number], BuiltinTraceEvent["type"]>,
] extends [never]
  ? true
  : false = true;
void _everyEventTypeIsListed;
void _everyListedTypeIsAnEvent;

/**
 * A mapped event whose kind the engine does not declare, because a capability
 * recorded it.
 *
 * @remarks The mapped mirror of the open arm of
 * {@link import("./trace-kinds.ts").TraceEntry}. It exists because dropping such
 * an entry — which is what the mapper did before there was anywhere to put it —
 * silently deleted a capability's forensics from the persisted trace while the
 * run's own context still showed them. The payload stays nested under `detail`
 * rather than spread flat: the engine cannot know a contributed detail's shape,
 * and spreading it would let a capability collide with `type` or `occurred_at`.
 */
export interface ContributedTraceEvent {
  type: string;
  occurred_at: number;
  detail: unknown;
}

/**
 * A capability-owned flat projection whose exact fields are opaque to the
 * engine but stable for that capability's persisted format.
 */
export interface PersistedContributedTraceEvent {
  type: string;
  [field: string]: unknown;
}

/**
 * One mapped, absolute-time trace event: a {@link BuiltinTraceEvent}, the
 * generic {@link ContributedTraceEvent} fallback, or a flat
 * {@link PersistedContributedTraceEvent} produced by a capability projector.
 *
 * @remarks Narrow with {@link isBuiltinTraceEvent} before switching on `type`,
 * for the same reason {@link import("./trace-kinds.ts").isBuiltinTraceEntry}
 * exists: the contributed arm's `type` is `string` and would match every `case`.
 */
export type TraceEvent = BuiltinTraceEvent | ContributedTraceEvent | PersistedContributedTraceEvent;

const BUILTIN_TRACE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(BUILTIN_TRACE_EVENT_TYPES);

/**
 * Narrow a {@link TraceEvent} to the engine-declared {@link BuiltinTraceEvent}.
 *
 * @param event - any mapped event.
 * @returns `true` when `event.type` is one of {@link BUILTIN_TRACE_EVENT_TYPES}.
 */
export function isBuiltinTraceEvent(event: TraceEvent): event is BuiltinTraceEvent {
  return BUILTIN_TRACE_EVENT_TYPE_SET.has(event.type);
}

/**
 * How much of a run's persisted trace was lost or reconstructed by crash
 * recovery, when it was recovered from a damaged journal.
 *
 * @remarks The record half of the observability standard's crossing rule
 * (`specs/cross-cutting/observability.md` §1.1): the log half is `trace.journal_recovery_degraded`,
 * which only an operator reading stderr can see. Counts only — never the skipped
 * lines themselves, nor any content from them.
 */
export interface ExecutionRecovery {
  /**
   * Journal lines discarded as unparseable, so whatever they recorded is absent
   * from the trace.
   */
  skipped_lines: number;
  /**
   * `tool_call` events synthesized to settle calls whose real result never
   * arrived, so their `result` is a placeholder rather than the tool's output.
   */
  synthesized_tool_calls: number;
}

export interface ExecutionRecord {
  id: string;
  owner_key_name: string;
  status: ExecutionStatus;
  started_at: number;
  ended_at: number;
  elapsed_ms: number;
  request: RunRequest;
  response: RunResponse;
  trace: Trace;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cache_write_tokens: number;
  final_context?: ContextSnapshotEntry[];
  /**
   * Durable per-capability state, keyed by capability name, produced by each
   * {@link import("./contract.ts").RunCapability.finalizeRun} before the record
   * was built.
   *
   * @remarks Opaque to the engine on purpose: only the capability that wrote a
   * slot knows how to read it back. A host that renders one (the plans overlay
   * reading `capability_state.plans`) validates the shape at its own boundary.
   */
  capability_state?: Record<string, unknown>;
  /** Opaque, sanitized host snapshot captured once when the run starts. */
  host_metadata?: Record<string, unknown>;
  /**
   * Present only when this record was rebuilt from a damaged crash journal and
   * something was lost or synthesized.
   *
   * @remarks Absence means the record is intact, which is why it is set only
   * when a count is non-zero: an undamaged recovered run must be
   * indistinguishable from one persisted normally.
   */
  recovery?: ExecutionRecovery;
}
