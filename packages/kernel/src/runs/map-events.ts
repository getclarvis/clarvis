import {
  createSampler,
  isBuiltinTraceEvent,
  levelEnabled,
  NOOP_LOGGER,
  parseTaskTitle,
  sanitizeDeep,
  sanitizeText,
  TASK_TITLE_MAX,
  type CapabilityEvent,
  type Logger,
  type TraceEvent,
} from "@clarvis/capability";
import { MEMORY_CAPABILITY_NAME, MEMORY_INGEST_EVENT } from "@clarvis/memory/settings";
import type { MemoryIngestDetail, RunEvent, RunStatus } from "@clarvis/protocol";
import {
  isWorkflowPersistedTraceEvent,
  type WorkflowPersistedTraceEvent,
} from "@clarvis/workflows";
import { z } from "zod";
import { boundJsonValue } from "../core/bounded-json.ts";

/**
 * Sampler for {@link reportUnmapped}.
 *
 * @remarks Module-scoped because the two mappers share one budget: a format
 * skew produces the same `(path, kind)` pair on every event of that type, and
 * a rehydration replays a whole run's trace in one loop. One instance per
 * package, never a process singleton — two packages sharing a counter would
 * sample each other's events.
 */
const sampleUnmapped = createSampler();

/**
 * Report an event that reached a mapper and produced no protocol event.
 *
 * @param logger - the runs component's logger.
 * @param path - `engine` for the persisted trace, `capability` for the live channel.
 * @param kind - the event's own type discriminator.
 * @param capability - the owning capability, for the capability path.
 * @param reason - what specifically failed, when the mapper knows.
 * @remarks This is the documented rehydration hazard made visible.
 * `engineEventToProto` returns `null` for anything it does not recognize and
 * the rehydration path filters those away, so a format skew between the writer
 * and the reader deletes events from a restored session with no signal at
 * either end. It stays a log: what the mapper *returns* is unchanged, because a
 * client's event union is closed and forwarding an unrecognized shape into it
 * is the worse failure.
 */
function reportUnmapped(
  logger: Logger,
  path: "engine" | "capability",
  kind: string,
  capability?: string,
  reason?: string,
): void {
  if (!levelEnabled(logger, "debug")) return;
  if (!sampleUnmapped(`${path}\0${capability ?? ""}\0${kind}`)) return;
  logger.debug(
    {
      event: "runs.event.unmapped",
      path,
      kind,
      ...(capability !== undefined ? { capability } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    "an event produced no protocol projection and was dropped; a rehydrated session will not show it",
  );
}

/** Maximum serialized payload carried by the generic capability wire envelope. */
export const MAX_CAPABILITY_EVENT_DETAIL_BYTES = 64 * 1024;
const MAX_CAPABILITY_EVENT_DETAIL_DEPTH = 32;
const MAX_CAPABILITY_EVENT_DETAIL_NODES = 4_096;

// eslint-disable-next-line no-control-regex -- capability text is an untrusted terminal boundary.
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
// eslint-disable-next-line no-control-regex -- remaining terminal controls must not reach clients.
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** Remove terminal controls from remote/capability text after secret redaction. */
function terminalSafe(text: string): string {
  return sanitizeText(text).replace(ANSI_ESCAPE, "").replace(TERMINAL_CONTROL, "");
}

function terminalLabel(text: string): string {
  return [...terminalSafe(text.slice(0, 4_096))].slice(0, 256).join("");
}

const planTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pending", "in_progress", "returned", "done", "abandoned", "failed"]),
    detail: z.string().optional(),
    exit: z.string().optional(),
    assignee: z.string().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
/**
 * Closed public plan projection.
 *
 * @remarks Internal plan events also carry objective/context fields. Stripping
 * them here avoids either widening the closed protocol DTO or rejecting an
 * otherwise valid plan update.
 */
const planProjectionSchema = z
  .object({
    id: z.string(),
    path: z.string().optional(),
    title: z.string(),
    status: z.enum(["awaiting_approval", "active", "completed", "cancelled", "failed"]),
    retention: z.enum(["discard", "keep"]),
    revision: z.number().int().nonnegative(),
    spec_revision: z.number().int().nonnegative(),
    tasks: z.array(planTaskSchema),
  })
  .strip();
const PLAN_UPDATE_CHANGES = ["content", "task", "status", "recovery"] as const;
const capabilityRunEventSchemas: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  plan_created: planProjectionSchema,
  plan_updated: planProjectionSchema.extend({ change: z.enum(PLAN_UPDATE_CHANGES) }),
  plan_removed: z
    .object({
      id: z.string(),
      path: z.string().optional(),
      revision: z.number().int().nonnegative(),
      spec_revision: z.number().int().nonnegative(),
      title: z.string().optional(),
      status: planProjectionSchema.shape.status.optional(),
      retention: planProjectionSchema.shape.retention.optional(),
      tasks: z.array(planTaskSchema).optional(),
    })
    .strict(),
  plan_review_requested: planProjectionSchema,
  plan_review_resolved: planProjectionSchema.extend({
    outcome: z.enum(["approved", "changes_requested", "cancelled"]),
  }),
};

const memoryIngestSchema = z.discriminatedUnion("phase", [
  z.object({ execution_id: z.string(), phase: z.literal("started") }).strict(),
  z
    .object({
      execution_id: z.string(),
      phase: z.literal("queued"),
      indexer_run_id: z.string().optional(),
    })
    .strict(),
  z
    .object({
      execution_id: z.string(),
      phase: z.literal("done"),
      written: z.number().int().nonnegative().optional(),
      deleted: z.number().int().nonnegative().optional(),
      reindexed: z.boolean().optional(),
      skipped: z.boolean().optional(),
      note: z.string().optional(),
      indexer_run_id: z.string().optional(),
    })
    .strict(),
  z
    .object({
      execution_id: z.string(),
      phase: z.literal("failed"),
      error: z.string().optional(),
      indexer_run_id: z.string().optional(),
    })
    .strict(),
  z
    .object({ execution_id: z.string(), phase: z.literal("blocked"), note: z.string().optional() })
    .strict(),
]);

/** Return the longest UTF-8 prefix that fits `budget` without quadratic trimming. */
function utf8Prefix(value: string, budget: number): string {
  let low = 0;
  let high = Math.min(value.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))) low -= 1;
  return value.slice(0, low);
}

/** Sanitize and cap an open capability projection without retaining raw data. */
function boundedCapabilityDetail(detail: unknown): {
  detail?: unknown;
  truncated: boolean;
} {
  if (detail === undefined) return { truncated: false };
  const bounded = boundJsonValue(detail, {
    maxDepth: MAX_CAPABILITY_EVENT_DETAIL_DEPTH,
    maxNodes: MAX_CAPABILITY_EVENT_DETAIL_NODES,
    maxChars: MAX_CAPABILITY_EVENT_DETAIL_BYTES,
    transformKey: terminalSafe,
  });
  const sanitized = sanitizeDeep(bounded.value, terminalSafe);
  let encoded: string;
  try {
    encoded = JSON.stringify(sanitized);
  } catch {
    return { detail: "[unserializable capability event]", truncated: true };
  }
  if (Buffer.byteLength(encoded, "utf8") <= MAX_CAPABILITY_EVENT_DETAIL_BYTES) {
    return { detail: sanitized, truncated: bounded.truncated };
  }
  const suffix = "…[truncated]";
  const budget = MAX_CAPABILITY_EVENT_DETAIL_BYTES - Buffer.byteLength(suffix, "utf8");
  return { detail: `${utf8Prefix(encoded, budget)}${suffix}`, truncated: true };
}

/** The phases a memory ingest notice may report. Kept in sync with the
 * protocol's {@link MemoryIngestDetail} union — a phase missing here is
 * silently dropped instead of reaching a client. */
/**
 * Narrow a capability event's opaque payload to a memory ingest notice.
 *
 * @param detail - the `detail` field of a capability event, typed `unknown`
 *   because the channel carries every capability's payloads.
 * @returns the notice, or null when the payload is absent or carries no
 *   recognizable `phase`.
 * @remarks The wire event declares a typed union, so a payload that does not
 *   match it is dropped rather than forwarded — a client that switches
 *   exhaustively on `phase` must never receive something outside the union.
 */
function toMemoryIngestDetail(detail: unknown, logger: Logger): MemoryIngestDetail | null {
  const bounded = boundedCapabilityDetail(detail);
  if (bounded.truncated) {
    reportUnmapped(logger, "capability", MEMORY_INGEST_EVENT, MEMORY_CAPABILITY_NAME, "truncated");
    return null;
  }
  const parsed = memoryIngestSchema.safeParse(bounded.detail);
  if (parsed.success) return parsed.data;
  reportUnmapped(logger, "capability", MEMORY_INGEST_EVENT, MEMORY_CAPABILITY_NAME, "schema");
  return null;
}

/** Maps a run-ended reason onto a protocol {@link RunStatus}; any reason other
 * than `completed`/`cancelled` collapses to `failed`. */
function endedReasonToStatus(reason: string): RunStatus {
  if (reason === "completed") return "completed";
  if (reason === "cancelled") return "cancelled";
  return "failed";
}

/** Bound the label on a legacy workflow trace that carried only `task`. */
function legacyWorkflowTitle(task: string): string {
  const first =
    task
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "leader";
  const parsed = parseTaskTitle(first);
  return parsed.ok ? parsed.title : [...first].slice(0, TASK_TITLE_MAX).join("");
}

/** Spreadable `subagent_id` fragment: the key is present only when `id` is
 * defined, so lead events stay free of an `undefined` field. */
function sub(id: string | undefined): { subagent_id?: string } {
  return id !== undefined ? { subagent_id: id } : {};
}

/** Map the workflows capability's narrow persisted-event union to protocol DTOs. */
function workflowEventToProto(event: WorkflowPersistedTraceEvent): RunEvent {
  switch (event.type) {
    case "workflow_run_started":
      return {
        type: "workflow_run_started",
        at: event.started_at,
        run_id: event.run_id,
        parent_run_id: event.parent_run_id,
        ...(event.profile !== undefined ? { profile: event.profile } : {}),
        title: event.title ?? legacyWorkflowTitle(event.task),
        task: event.task,
        ...(event.round_id !== undefined ? { round_id: event.round_id } : {}),
        ...(event.pass !== undefined ? { pass: event.pass } : {}),
        ...(event.item_index !== undefined ? { item_index: event.item_index } : {}),
        ...(event.replica !== undefined ? { replica: event.replica } : {}),
        ...(event.replica_count !== undefined ? { replica_count: event.replica_count } : {}),
      };
    case "workflow_run_completed":
      return {
        type: "workflow_run_completed",
        at: event.completed_at,
        run_id: event.run_id,
        parent_run_id: event.parent_run_id,
        status: "completed",
      };
    case "workflow_run_failed":
      return {
        type: "workflow_run_failed",
        at: event.completed_at,
        run_id: event.run_id,
        parent_run_id: event.parent_run_id,
        status: endedReasonToStatus(event.status),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Maps a capability-channel {@link CapabilityEvent} to a protocol
 * {@link RunEvent}, or `null` when the event carries nothing a client renders.
 *
 * @param event - an event emitted on the loop's capability channel.
 * @returns the memory-ingest event (only for the memory capability's ingest
 *   event with a recognized phase), an event built from the emitter's declared
 *   {@link CapabilityEvent.wire} projection, or `null` when the event declares
 *   no projection or carries no detail.
 * @remarks Plan and delegation events reach a client through this channel rather
 *   than the engine trace; see {@link engineEventToProto} for the trace path.
 *
 *   The projection is read off the event rather than matched against a list of
 *   capability names this function was written to know about. That list was the
 *   defect: any capability the kernel had not been taught about — including one
 *   shipped in its own package, which is the whole point of the capability
 *   contract — had its events dropped in silence, with nothing at the emitting
 *   end to say so. Memory keeps a typed path because its detail is validated
 *   against the protocol here, which stays the kernel's job.
 *
 *   A typed capability projection passes a closed runtime schema before its
 *   discriminator and timestamp are written. Opaque projections use the
 *   generic bounded variant, so capability detail can replace neither field.
 */
export function capabilityEventToProto(
  event: CapabilityEvent,
  logger: Logger = NOOP_LOGGER,
): RunEvent | null {
  if (event.capability === MEMORY_CAPABILITY_NAME) {
    if (event.kind !== MEMORY_INGEST_EVENT) {
      reportUnmapped(logger, "capability", event.kind, event.capability, "not_ingest");
      return null;
    }
    const detail = toMemoryIngestDetail(event.detail, logger);
    return detail === null ? null : { type: "memory_ingest", at: Date.now(), detail };
  }
  if (event.wire === undefined || event.wire.detail === undefined) {
    reportUnmapped(logger, "capability", event.kind, event.capability, "no_wire_projection");
    return null;
  }
  const bounded = boundedCapabilityDetail(event.wire.detail);
  const schema = capabilityRunEventSchemas[event.wire.type];
  if (schema !== undefined && !bounded.truncated) {
    const parsed = schema.safeParse(bounded.detail);
    if (parsed.success) {
      return { ...parsed.data, type: event.wire.type, at: Date.now() } as RunEvent;
    }
  }
  return {
    type: "capability_event",
    at: Date.now(),
    capability: terminalLabel(event.capability),
    kind: terminalLabel(event.kind),
    projection: terminalLabel(event.wire.type),
    ...bounded,
  };
}

/**
 * Maps an engine {@link TraceEvent} to a protocol {@link RunEvent}, or `null` for unsupported types.
 *
 * @param ev - a trace event from the engine (live or replayed on rehydration).
 * @returns the workflow DTO for a validated workflow-owned persisted event;
 *   `null` for another capability-contributed event (e.g. `plan_review`, whose
 *   outcome reaches clients on the capability channel instead — see
 *   {@link capabilityEventToProto}) or a builtin type with no wire projection;
 *   otherwise the corresponding protocol event.
 * @remarks This is the trace path; any event a rehydrated session must show has
 *   to be mapped here, since rehydration reads only the persisted trace.
 *
 *   Workflow events are narrowed through the workflows package's own runtime
 *   guard first. {@link isBuiltinTraceEvent} then narrows the remaining events
 *   before the engine switch, preserving exhaustiveness despite the open
 *   contributed-event arm.
 *
 *   Optional engine fields are spread in only when present, so absent data
 *   never becomes an explicit `undefined` on the wire.
 */
export function engineEventToProto(ev: TraceEvent, logger: Logger = NOOP_LOGGER): RunEvent | null {
  if (isWorkflowPersistedTraceEvent(ev)) return workflowEventToProto(ev);
  if (!isBuiltinTraceEvent(ev)) {
    reportUnmapped(logger, "engine", String(ev.type), undefined, "not_builtin");
    return null;
  }
  switch (ev.type) {
    case "run_started":
      return {
        type: "run_started",
        at: ev.occurred_at,
        ...(ev.lead_model !== undefined ? { lead_model: ev.lead_model } : {}),
        ...(ev.subagent_model !== undefined ? { subagent_model: ev.subagent_model } : {}),
      };
    case "run_ended":
      return {
        type: "run_ended",
        at: ev.occurred_at,
        status: endedReasonToStatus(ev.reason),
        reason: ev.reason,
        ...(ev.code === undefined ? {} : { code: ev.code }),
      };

    case "lead_iteration_started":
      return {
        type: "iteration_started",
        at: ev.started_at,
        agent: "lead",
        iteration: ev.iteration,
        model: ev.model,
      };
    case "subagent_iteration_started":
      return {
        type: "iteration_started",
        at: ev.started_at,
        agent: "subagent",
        subagent_id: ev.subagent_instance_id,
        iteration: ev.iteration,
        model: ev.model,
      };
    case "lead_iteration":
      return {
        type: "iteration_completed",
        at: ev.ended_at,
        agent: "lead",
        iteration: ev.iteration,
        model: ev.model,
        response: ev.response,
        ...(ev.response_phase !== undefined ? { response_phase: ev.response_phase } : {}),
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        cached_tokens: ev.cached_tokens,
      };
    case "subagent_iteration":
      return {
        type: "iteration_completed",
        at: ev.ended_at,
        agent: "subagent",
        subagent_id: ev.subagent_instance_id,
        iteration: ev.iteration,
        model: ev.model,
        response: ev.response,
        ...(ev.response_phase !== undefined ? { response_phase: ev.response_phase } : {}),
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        cached_tokens: ev.cached_tokens,
      };

    case "tool_call_started":
      return {
        type: "tool_call_started",
        at: ev.started_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        call_id: ev.call_id,
        tool: ev.tool_name,
        server: ev.mcp_name,
        arguments: ev.arguments as Record<string, unknown>,
      };
    case "tool_output_delta":
      return {
        type: "tool_output_delta",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        call_id: ev.call_id,
        chunk: ev.chunk,
      };
    case "tool_input_delta":
      return {
        type: "tool_input_delta",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        call_id: ev.call_id,
        tool: ev.tool_name,
        chars: ev.chars,
        ...(ev.stream_chars !== undefined ? { stream_chars: ev.stream_chars } : {}),
        ...(ev.complete === true ? { complete: true } : {}),
      };
    case "tool_call":
      return {
        type: "tool_call",
        at: ev.ended_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        ...(ev.call_id !== undefined ? { call_id: ev.call_id } : {}),
        tool: ev.tool_name,
        server: ev.mcp_name,
        arguments: ev.arguments as Record<string, unknown>,
        ok: ev.error === null,
        result: ev.result,
        ...(ev.error !== null ? { error: ev.error } : {}),
        ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
        ...(ev.guard !== undefined ? { guard: ev.guard } : {}),
      };

    case "model_reasoning":
      return {
        type: "reasoning",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        iteration: ev.iteration,
        text: ev.text,
      };
    case "model_stream_delta":
      return {
        type: "text_delta",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        iteration: ev.iteration,
        channel: ev.channel,
        text: ev.text,
        reset: ev.reset,
      };
    case "model_call_error":
      return {
        type: "model_error",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        iteration: ev.iteration,
        kind: ev.kind,
        message: ev.message,
      };

    case "model_call_retry":
      return {
        type: "model_retry",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        iteration: ev.iteration,
        kind: ev.kind,
        attempt: ev.attempt,
        max_retries: ev.max_retries,
        delay_ms: ev.delay_ms,
        ...(ev.status !== undefined ? { status: ev.status } : {}),
        ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
      };

    case "delegation_created":
      return {
        type: "delegation_created",
        at: ev.spawned_at,
        delegation_id: ev.delegation_id,
        ...(ev.task_id !== undefined ? { task_id: ev.task_id } : {}),
        title: ev.title,
        task: ev.task,
        ...(ev.profile !== undefined ? { profile: ev.profile } : {}),
        tools: ev.tools,
      };
    case "delegation_started":
      return {
        type: "delegation_started",
        at: ev.occurred_at,
        delegation_id: ev.delegation_id,
        ...(ev.task_id !== undefined ? { task_id: ev.task_id } : {}),
        model: ev.model,
      };
    case "delegation_completed":
    case "delegation_failed":
      return {
        type: ev.type,
        at: ev.completed_at,
        delegation_id: ev.delegation_id,
        ...(ev.task_id !== undefined ? { task_id: ev.task_id } : {}),
        status: ev.status,
        summary: terminalLabel(ev.result),
      };

    /**
     * Two kinds, unmapped for two different reasons, sharing an arm because the
     * outcome is the same.
     *
     * `convergence_warning` is engine-internal *for now*. The warning already
     * reaches the model as a runtime note and the record as a persisted event;
     * whether a UI should surface "this run is close to a convergence limit" —
     * and how — is a product decision that has not been made.
     *
     * `guard_escalation` is not unfinished at all, and does not become a
     * `RunEvent` because the client has already been asked. A tripped guard
     * escalates through the elicitation port under its own
     * `kind: "guard_escalation"`, so the UI meets it as a question it must
     * answer — "the run looks stuck, keep going?" — rather than as an event it
     * may render. Publishing it here as well would tell a client twice about one
     * thing it is already blocking on. The trace still records the outcome, so
     * the audit trail is complete either way.
     *
     * Both are handled explicitly rather than left to the `default` below, so
     * the omission reads as a choice.
     */
    case "convergence_warning":
    case "guard_escalation":
      reportUnmapped(logger, "engine", ev.type, undefined, "deliberately_internal");
      return null;

    case "soft_limit_check":
      return {
        type: "soft_limit_check",
        at: ev.occurred_at,
        dimension: ev.dimension,
        used: ev.used,
        limit: ev.limit,
        outcome: ev.outcome,
      };
    case "compaction_started":
      return {
        type: "compaction_started",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        mode: ev.mode,
      };
    case "compaction":
      return {
        type: "compaction",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        operation: ev.operation,
        ...(ev.fallback_reason !== undefined ? { fallback_reason: ev.fallback_reason } : {}),
        ...(ev.freed_chars !== undefined ? { freed_chars: ev.freed_chars } : {}),
        ...(ev.contribution_count !== undefined
          ? { contribution_count: ev.contribution_count }
          : {}),
        ...(ev.requested !== undefined ? { requested: ev.requested } : {}),
        ...(ev.user_contribution_count !== undefined
          ? { user_contribution_count: ev.user_contribution_count }
          : {}),
      };
    case "compaction_skipped":
      return {
        type: "compaction_skipped",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        reason: ev.reason,
      };
    case "vision_analysis":
      return {
        type: "vision_analysis",
        at: ev.occurred_at,
        model: ev.model,
        image_count: ev.image_count,
        status: ev.status,
        result: ev.result,
      };

    case "elicitation_requested":
      return {
        type: "elicitation_requested",
        at: ev.occurred_at,
        ...(ev.agent !== undefined ? { agent: ev.agent } : {}),
        ...sub(ev.subagent_instance_id),
        question: ev.question,
        ...(ev.options !== undefined ? { options: ev.options } : {}),
      };
    case "user_question":
      return {
        type: "elicitation_resolved",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        question: ev.question,
        outcome: ev.outcome,
        ...(ev.answer !== undefined ? { answer: ev.answer } : {}),
        ...(ev.options !== undefined ? { options: ev.options } : {}),
      };
    case "user_steering":
      return {
        type: "steering_applied",
        at: ev.occurred_at,
        agent: ev.agent,
        ...sub(ev.subagent_instance_id),
        message: ev.message,
      };

    case "mcp_degraded":
      return {
        type: "mcp_degraded",
        at: ev.occurred_at,
        servers: ev.servers.map((s) => ({ name: s.name, reason: s.reason })),
      };

    default:
      reportUnmapped(logger, "engine", (ev as { type: string }).type, undefined, "no_projection");
      return null;
  }
}
