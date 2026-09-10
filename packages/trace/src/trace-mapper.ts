import { isBuiltinTraceEntry, type TraceEntry } from "@clarvis/capability";
import type { Trace, TraceEvent } from "@clarvis/capability";
import type { PersistedTraceProjectorRegistry } from "@clarvis/capability";
import { sanitizeDeep } from "@clarvis/capability";
import { ARGS_MAX, capDetail, truncateTail } from "./cap-detail.ts";

function splitToolName(fullName: string): { mcp_name: string; tool_name: string } {
  const dot = fullName.indexOf(".");
  if (dot === -1) return { mcp_name: fullName, tool_name: "" };
  return { mcp_name: fullName.slice(0, dot), tool_name: fullName.slice(dot + 1) };
}

/**
 * Coerce a persisted `arguments` payload to the object the wire type requires,
 * **preserving** anything that is not already one under a `malformed_arguments`
 * key rather than discarding it.
 *
 * @remarks Returning a bare `{}` here is what made a truncated tool call
 *   undiagnosable: the engine had already substituted `{}` before dispatch, and
 *   this erased the only other copy, so the persisted trace asserted the model
 *   sent no arguments when it had sent a payload that was cut in transit. The
 *   truth survived solely in the run's final context, which this mapper does not
 *   touch. A trace that quietly disagrees with what happened is worse than one
 *   that carries an oddly-shaped value.
 */
function asObject(value: unknown): object {
  if (typeof value === "object" && value !== null) return value;
  if (value === undefined) return {};
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = "";
  }
  return { malformed_arguments: truncateTail(text, ARGS_MAX) };
}

/**
 * Map one internal {@link TraceEntry} to a persistable {@link TraceEvent},
 * converting relative offsets to absolute timestamps, applying the canonical
 * detail caps, and stripping secrets.
 *
 * @param entry - the raw trace entry from the engine.
 * @param wallStartedAt - absolute run start (ms) that per-entry offsets are added to.
 * @param projectors - optional immutable capability-owned projection registry.
 * @returns the sanitized event, or `null` for entries with no persistable
 *   projection (`init`, `terminate`, and the `agent_*` supervision kinds).
 * @remarks The supervision kinds are engine-internal on purpose: they exist so a
 *   run's own trace explains what a parent did to its children, and no wire
 *   {@link TraceEvent} stands for them. Minting one would propagate through
 *   `@clarvis/protocol`, `@clarvis/kernel`, `@clarvis/code` and
 *   `@clarvis/server`'s exhaustive event view — which is exactly the reach the
 *   agent-supervision work leaves for the later human-facing surface.
 */
export function mapEntry(
  entry: TraceEntry,
  wallStartedAt: number,
  projectors?: PersistedTraceProjectorRegistry,
): TraceEvent | null {
  const event = mapEntryRaw(entry, wallStartedAt, projectors);
  return event === null ? null : sanitizeDeep(event);
}

/**
 * The per-kind mapping core behind {@link mapEntry}, before sanitization.
 *
 * @param entry - the raw trace entry.
 * @param wallStartedAt - absolute run start (ms); the local `abs` helper adds
 *   each entry's rounded offset to it.
 * @returns the mapped event: the matching capability projection when one is
 *   registered; `null` for `init`/`terminate` and the `agent_*` supervision
 *   kinds; a {@link ContributedTraceEvent} — `type` carried through,
 *   `occurred_at` rebased, `detail` string-capped by `capDetail` since its shape
 *   is unknown here — for another contributed kind; otherwise the matching
 *   builtin projection. The `default` branch is a compile-time exhaustiveness
 *   guard over `BuiltinTraceKind`.
 * @remarks The {@link isBuiltinTraceEntry} check above the switch is what keeps
 *   that guard meaningful now that {@link TraceEntry} is open: without it the
 *   contributed arm — whose `kind` is `string` — would match every `case`,
 *   erasing each branch's `detail` type to `unknown` and leaving a `default`
 *   residual that is no longer `never`. It branches the other way first,
 *   mapping a contributed entry directly, because dropping it here is what used
 *   to delete a capability's forensics from the persisted trace while the run's
 *   own context still showed them.
 * @remarks Every built-in branch obtains its bounded detail from {@link capDetail};
 *   the mapper owns projection only. This is also a defence-in-depth pass for an
 *   entry that reached persistence without going through `createTrace`.
 *   Optional fields are attached only when defined so absent data never becomes
 *   explicit `undefined`.
 */
function mapEntryRaw(
  entry: TraceEntry,
  wallStartedAt: number,
  projectors?: PersistedTraceProjectorRegistry,
): TraceEvent | null {
  const abs = (offset: number): number => wallStartedAt + Math.round(offset);
  const projector = projectors?.projectorFor(entry.kind);
  if (projector !== undefined) {
    return projector.project(entry, { absoluteTime: abs });
  }
  if (!isBuiltinTraceEntry(entry)) {
    return {
      type: entry.kind,
      occurred_at: abs(entry.at),
      detail: capDetail(entry.kind, entry.detail),
    };
  }
  switch (entry.kind) {
    case "lead_iteration": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "lead_iteration",
        iteration: d.iteration,
        started_at: abs(d.started_at),
        ended_at: abs(d.ended_at),
        model: d.model,
        input_tokens: d.input_tokens,
        output_tokens: d.output_tokens,
        cached_tokens: d.cached_tokens,
        cache_write_tokens: d.cache_write_tokens,
        cache_read_ratio: d.cache_read_ratio,
        response: d.response,
        ...(d.response_phase !== undefined ? { response_phase: d.response_phase } : {}),
      };
    }
    case "subagent_iteration": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "subagent_iteration",
        subagent_instance_id: d.subagent_instance_id,
        iteration: d.iteration,
        started_at: abs(d.started_at),
        ended_at: abs(d.ended_at),
        model: d.model,
        input_tokens: d.input_tokens,
        output_tokens: d.output_tokens,
        cached_tokens: d.cached_tokens,
        cache_write_tokens: d.cache_write_tokens,
        cache_read_ratio: d.cache_read_ratio,
        response: d.response,
        ...(d.response_phase !== undefined ? { response_phase: d.response_phase } : {}),
      };
    }
    case "tool_call": {
      const d = capDetail(entry.kind, entry.detail);
      const { mcp_name, tool_name } = splitToolName(d.name);
      const event: Extract<TraceEvent, { type: "tool_call" }> = {
        type: "tool_call",
        agent: d.agent,
        iteration_ref: d.iteration_ref,
        started_at: abs(d.started_at),
        ended_at: abs(d.ended_at),
        mcp_name,
        tool_name,
        arguments: asObject(d.arguments),
        result: d.result,
        error: d.error,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.call_id !== undefined) event.call_id = d.call_id;
      if (d.diff !== undefined) event.diff = d.diff;
      if (d.guard !== undefined) event.guard = d.guard;
      return event;
    }
    case "tool_call_started": {
      const d = capDetail(entry.kind, entry.detail);
      const { mcp_name, tool_name } = splitToolName(d.name);
      const event: Extract<TraceEvent, { type: "tool_call_started" }> = {
        type: "tool_call_started",
        agent: d.agent,
        call_id: d.call_id,
        iteration_ref: d.iteration_ref,
        started_at: abs(d.started_at),
        mcp_name,
        tool_name,
        arguments: asObject(d.arguments),
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "tool_output_delta": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "tool_output_delta" }> = {
        type: "tool_output_delta",
        agent: d.agent,
        call_id: d.call_id,
        occurred_at: abs(entry.at),
        chunk: d.chunk,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "tool_input_delta": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "tool_input_delta" }> = {
        type: "tool_input_delta",
        agent: d.agent,
        call_id: d.call_id,
        occurred_at: abs(entry.at),
        tool_name: d.tool_name,
        chars: d.chars,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.stream_chars !== undefined) event.stream_chars = d.stream_chars;
      if (d.complete === true) event.complete = true;
      return event;
    }
    case "subagent_iteration_started": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "subagent_iteration_started",
        subagent_instance_id: d.subagent_instance_id,
        iteration: d.iteration,
        started_at: abs(d.started_at),
        model: d.model,
      };
    }
    case "lead_iteration_started": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "lead_iteration_started",
        iteration: d.iteration,
        started_at: abs(d.started_at),
        model: d.model,
      };
    }
    case "delegation_created": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "delegation_created" }> = {
        type: "delegation_created",
        delegation_id: d.delegation_id,
        spawned_at: abs(entry.at),
        title: d.title,
        task: d.task,
        tools: d.tools,
      };
      if (d.task_id !== undefined) event.task_id = d.task_id;
      if (d.profile !== undefined) event.profile = d.profile;
      return event;
    }
    case "delegation_completed":
    case "delegation_failed": {
      const d = capDetail(entry.kind, entry.detail);
      const base = {
        delegation_id: d.delegation_id,
        ...(d.task_id === undefined ? {} : { task_id: d.task_id }),
        completed_at: abs(entry.at),
        status: d.status,
        result: d.result,
      };
      return entry.kind === "delegation_completed"
        ? { type: "delegation_completed", ...base }
        : { type: "delegation_failed", ...base };
    }
    case "budget_check": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "budget_check" }> = {
        type: "budget_check",
        checked_at: abs(entry.at),
        tokens_used: d.tokens_used,
      };
      if (Number.isFinite(d.tokens_remaining)) event.tokens_remaining = d.tokens_remaining;
      return event;
    }
    case "compaction_started": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "compaction_started",
        agent: d.agent,
        ...(d.subagent_instance_id !== undefined
          ? { subagent_instance_id: d.subagent_instance_id }
          : {}),
        mode: d.mode,
        occurred_at: abs(entry.at),
      };
    }
    case "compaction": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "compaction" }> = {
        type: "compaction",
        agent: d.agent,
        operation: d.operation,
        occurred_at: abs(entry.at),
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.fallback_reason !== undefined) event.fallback_reason = d.fallback_reason;
      if (d.evicted_count !== undefined) event.evicted_count = d.evicted_count;
      if (d.freed_chars !== undefined) event.freed_chars = d.freed_chars;
      if (d.original_chars !== undefined) event.original_chars = d.original_chars;
      if (d.kept_chars !== undefined) event.kept_chars = d.kept_chars;
      if (d.anchor_chars !== undefined) event.anchor_chars = d.anchor_chars;
      if (d.anchor_updated !== undefined) event.anchor_updated = d.anchor_updated;
      if (d.contribution_count !== undefined) event.contribution_count = d.contribution_count;
      if (d.requested !== undefined) event.requested = d.requested;
      if (d.user_contribution_count !== undefined)
        event.user_contribution_count = d.user_contribution_count;
      if (d.task_id !== undefined) event.task_id = d.task_id;
      return event;
    }
    case "vision_analysis": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "vision_analysis",
        model: d.model,
        image_count: d.image_count,
        status: d.status,
        result: d.result,
        occurred_at: abs(entry.at),
      };
    }
    case "compaction_skipped": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "compaction_skipped",
        agent: d.agent,
        ...(d.subagent_instance_id !== undefined
          ? { subagent_instance_id: d.subagent_instance_id }
          : {}),
        occurred_at: abs(entry.at),
        reason: d.reason,
      };
    }
    case "cancellation": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "cancellation" }> = {
        type: "cancellation",
        agent: d.agent,
        occurred_at: abs(entry.at),
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.reason !== undefined) event.reason = d.reason;
      return event;
    }
    case "user_question": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "user_question" }> = {
        type: "user_question",
        agent: d.agent,
        iteration_ref: d.iteration_ref,
        occurred_at: abs(entry.at),
        question: d.question,
        outcome: d.outcome,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.answer !== undefined) event.answer = d.answer;
      if (d.options !== undefined) event.options = d.options;
      return event;
    }
    case "user_steering": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "user_steering" }> = {
        type: "user_steering",
        agent: d.agent,
        iteration_ref: d.iteration_ref,
        occurred_at: abs(entry.at),
        message: d.message,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.id !== undefined) event.id = d.id;
      return event;
    }
    case "soft_limit_check": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "soft_limit_check" }> = {
        type: "soft_limit_check",
        agent: d.agent,
        occurred_at: abs(entry.at),
        dimension: d.dimension,
        used: d.used,
        limit: d.limit,
        outcome: d.outcome,
        escalations: d.escalations,
      };
      if (d.new_checkpoint !== undefined) event.new_checkpoint = d.new_checkpoint;
      return event;
    }
    case "run_started": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "run_started" }> = {
        type: "run_started",
        occurred_at: abs(entry.at),
        mode: d.mode,
      };
      if (d.lead_model !== undefined) event.lead_model = d.lead_model;
      if (d.subagent_model !== undefined) event.subagent_model = d.subagent_model;
      if (d.max_tokens !== undefined) event.max_tokens = d.max_tokens;
      return event;
    }
    case "run_ended": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "run_ended" }> = {
        type: "run_ended",
        occurred_at: abs(entry.at),
        reason: d.reason,
      };
      if (d.code !== undefined) event.code = d.code;
      if (d.reason === "completed" && d.disposition !== undefined)
        event.disposition = d.disposition;
      return event;
    }
    case "delegation_started": {
      const d = capDetail(entry.kind, entry.detail);
      return {
        type: "delegation_started",
        delegation_id: d.delegation_id,
        ...(d.task_id === undefined ? {} : { task_id: d.task_id }),
        occurred_at: abs(entry.at),
        model: d.model,
      };
    }
    case "model_call_error": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "model_call_error" }> = {
        type: "model_call_error",
        agent: d.agent,
        iteration: d.iteration,
        occurred_at: abs(entry.at),
        model: d.model,
        kind: d.kind,
        message: d.message,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.status !== undefined) event.status = d.status;
      if (d.retry_after_ms !== undefined) event.retry_after_ms = d.retry_after_ms;
      if (d.usage_attributed !== undefined) event.usage_attributed = d.usage_attributed;
      return event;
    }
    case "guard_escalation": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "guard_escalation" }> = {
        type: "guard_escalation",
        agent: d.agent,
        occurred_at: abs(entry.at),
        code: d.code,
        outcome: d.outcome,
        escalations: d.escalations,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "convergence_warning": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "convergence_warning" }> = {
        type: "convergence_warning",
        agent: d.agent,
        occurred_at: abs(entry.at),
        code: d.code,
        message: d.message,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "model_call_retry": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "model_call_retry" }> = {
        type: "model_call_retry",
        agent: d.agent,
        iteration: d.iteration,
        occurred_at: abs(entry.at),
        model: d.model,
        kind: d.kind,
        message: d.message,
        attempt: d.attempt,
        max_retries: d.max_retries,
        delay_ms: d.delay_ms,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.status !== undefined) event.status = d.status;
      if (d.retry_after_ms !== undefined) event.retry_after_ms = d.retry_after_ms;
      return event;
    }
    case "model_reasoning": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "model_reasoning" }> = {
        type: "model_reasoning",
        agent: d.agent,
        iteration: d.iteration,
        occurred_at: abs(entry.at),
        model: d.model,
        text: d.text,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "model_stream_delta": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "model_stream_delta" }> = {
        type: "model_stream_delta",
        agent: d.agent,
        iteration: d.iteration,
        occurred_at: abs(entry.at),
        model: d.model,
        channel: d.channel,
        text: d.text,
        reset: d.reset,
      };
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      return event;
    }
    case "elicitation_requested": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "elicitation_requested" }> = {
        type: "elicitation_requested",
        occurred_at: abs(entry.at),
        source: d.source,
        question: d.question,
      };
      if (d.agent !== undefined) event.agent = d.agent;
      if (d.iteration_ref !== undefined) event.iteration_ref = d.iteration_ref;
      if (d.subagent_instance_id !== undefined) event.subagent_instance_id = d.subagent_instance_id;
      if (d.options !== undefined) event.options = d.options;
      return event;
    }
    case "mcp_degraded": {
      const d = capDetail(entry.kind, entry.detail);
      const event: Extract<TraceEvent, { type: "mcp_degraded" }> = {
        type: "mcp_degraded",
        occurred_at: abs(entry.at),
        servers: d.servers.map((s) => ({
          name: s.name,
          transport: s.transport,
          reason: s.reason,
        })),
      };
      return event;
    }
    case "init":
    case "terminate":
    case "agent_registered":
    case "agent_stopped":
    case "agent_steered":
    case "agent_finish_nudge":
      return null;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/**
 * Map a full sequence of trace entries into a persistable {@link Trace},
 * dropping entries with no projection.
 *
 * @param entries - the engine's ordered trace entries.
 * @param wallStartedAt - absolute run start (ms) for timestamp resolution.
 * @param projectors - optional immutable capability-owned projection registry.
 * @returns a `Trace` whose `events` are the non-null {@link mapEntry} results,
 *   in order.
 */
export function mapTrace(
  entries: TraceEntry[],
  wallStartedAt: number,
  projectors?: PersistedTraceProjectorRegistry,
): Trace {
  const events: TraceEvent[] = [];
  for (const entry of entries) {
    const event = mapEntry(entry, wallStartedAt, projectors);
    if (event !== null) events.push(event);
  }
  return { events };
}
