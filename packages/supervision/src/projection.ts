/**
 * `TraceEntry` / `TraceEvent` → one line of a child's activity log.
 *
 * @remarks This is what makes `agent_poll` answer *"is it going well?"* rather
 * than merely *"is it alive?"*, without the parent paying for the child's
 * context — which is the cost delegation exists to avoid. Raw trace JSON in a
 * parent's context is a token fire; a lifecycle-only projection tells a parent a
 * child is running but not that it has failed the same test four times.
 *
 * Deliberately **not** an exhaustive switch. `mapEntry` and `@clarvis/server`'s
 * `viewOf` are already exhaustive over the trace vocabulary and break the build
 * when a kind is added — two such gates are enough, and a third would make every
 * new event kind a chore here for no gain. An unrecognized kind projects to
 * `null`, which is also the correct answer for the high-frequency signal-only
 * kinds (`model_stream_delta`, `tool_output_delta`): they reach a trace sink even
 * though they never reach `entries()`, so filtering them is load-bearing.
 */
import type { TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";

/** A trace record normalized across the two shapes a child's activity arrives in. */
export interface ProjectionSource {
  kind: string;
  detail: Record<string, unknown>;
}

/** Carried between lines so a projection can render an elicitation's wait age
 * and suppress a repeated iteration banner. */
export interface ProjectionState {
  lastIteration?: number;
  /** When the still-open elicitation was requested, in epoch ms. */
  waitingSince?: number;
}

/** How much of a tool argument's value survives into a projected line. */
const ARG_VALUE_CHARS = 48;

/** How much of an assistant turn survives into a projected line. */
const TEXT_CHARS = 160;

/**
 * Adapt an engine {@link TraceEntry} (nested envelope, the sub-agent path).
 */
export function fromTraceEntry(entry: TraceEntry): ProjectionSource {
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  return { kind: entry.kind, detail };
}

/**
 * Adapt a wire {@link TraceEvent} (flat, the leader path).
 *
 * @remarks The wire form splits a tool's `name` into `mcp_name`/`tool_name`;
 *   this reassembles it so one projector serves both shapes.
 */
export function fromTraceEvent(event: TraceEvent): ProjectionSource {
  const detail = { ...(event as unknown as Record<string, unknown>) };
  if (typeof detail.tool_name === "string") {
    const mcp = typeof detail.mcp_name === "string" ? detail.mcp_name : "";
    detail.name = mcp.length > 0 ? `${mcp}.${String(detail.tool_name)}` : String(detail.tool_name);
  }
  return { kind: event.type, detail };
}

/** Human-readable byte size, e.g. `412B` / `3.1kB`. */
function size(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes < 1024 ? `${String(bytes)}B` : `${(bytes / 1024).toFixed(1)}kB`;
}

/** Clip to `max` characters, marking that it was clipped. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * A short digest of a tool call's arguments: the first key with a truncated
 * value, plus a count of the rest.
 *
 * @remarks How much of the arguments belongs in a line is a judgment call; this
 *   starts deliberately small, because the cost of being wrong in the generous
 *   direction is paid on every tool call of every child.
 */
function digest(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const entries = Object.entries(args as Record<string, unknown>);
  const first = entries[0];
  if (first === undefined) return "{}";
  const [key, raw] = first;
  const value = typeof raw === "string" ? raw : JSON.stringify(raw);
  const shown = clip(value ?? "null", ARG_VALUE_CHARS);
  const rest = entries.length - 1;
  const tail = rest > 0 ? `, +${String(rest)} more` : "";
  return `{${key}:${JSON.stringify(shown)}${tail}}`;
}

/** The iteration tag a line carries, e.g. `[i3]`, or `[--]` when unscoped. */
function tag(state: ProjectionState): string {
  return state.lastIteration === undefined ? "[--]" : `[i${String(state.lastIteration)}]`;
}

function str(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

function num(detail: Record<string, unknown>, key: string): number | undefined {
  const value = detail[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Project one normalized trace record into a single log line.
 *
 * @param source - the normalized record, from {@link fromTraceEntry} or
 *   {@link fromTraceEvent}.
 * @param state - mutable carry-over; updated in place with the current iteration
 *   and any open elicitation.
 * @param now - epoch ms used to age a pending elicitation.
 * @returns the line, or `null` when this kind is not worth a parent's context.
 */
export function projectAgentEvent(
  source: ProjectionSource,
  state: ProjectionState,
  now: number,
): string | null {
  const d = source.detail;
  switch (source.kind) {
    case "lead_iteration_started":
    case "subagent_iteration_started": {
      const iteration = num(d, "iteration");
      if (iteration === undefined || iteration === state.lastIteration) return null;
      state.lastIteration = iteration;
      return `[i${String(iteration)}] ---`;
    }
    case "lead_iteration":
    case "subagent_iteration": {
      const iteration = num(d, "iteration");
      if (iteration !== undefined) state.lastIteration = iteration;
      const response = str(d, "response") ?? "";
      if (response.length === 0) return null;
      return `${tag(state)} text ${JSON.stringify(clip(response, TEXT_CHARS))} (${size(response)})`;
    }
    case "tool_call": {
      const name = str(d, "name") ?? "?";
      const error = str(d, "error");
      const result = str(d, "result") ?? "";
      const body =
        error === undefined ? `ok ${size(result)}` : `err ${clip(error, ARG_VALUE_CHARS)}`;
      return `${tag(state)} tool ${name} ${digest(d.arguments)} → ${body}`;
    }
    case "delegation_created": {
      const title = str(d, "title") ?? str(d, "task") ?? "";
      return `${tag(state)} spawn sub-agent ${JSON.stringify(clip(title, ARG_VALUE_CHARS))}`;
    }
    case "workflow_run_started": {
      const task = str(d, "task") ?? "";
      return `${tag(state)} spawn leader ${JSON.stringify(clip(task, ARG_VALUE_CHARS))}`;
    }
    case "elicitation_requested": {
      state.waitingSince = now;
      const question = str(d, "question") ?? "";
      return `${tag(state)} elicit ${JSON.stringify(clip(question, ARG_VALUE_CHARS))} — WAITING`;
    }
    case "user_question": {
      const age = state.waitingSince === undefined ? undefined : now - state.waitingSince;
      state.waitingSince = undefined;
      const outcome = str(d, "outcome") ?? "?";
      const waited = age === undefined ? "" : ` after ${String(Math.round(age / 1000))}s`;
      return `${tag(state)} elicit resolved: ${outcome}${waited}`;
    }
    case "user_steering": {
      const message = str(d, "message") ?? "";
      return `${tag(state)} steer ${JSON.stringify(clip(message, ARG_VALUE_CHARS))}`;
    }
    case "cancellation": {
      const reason = str(d, "reason");
      return `${tag(state)} cancelled${reason === undefined ? "" : `: ${clip(reason, ARG_VALUE_CHARS)}`}`;
    }
    case "model_call_error": {
      const message = str(d, "message") ?? str(d, "error") ?? "";
      return `${tag(state)} model error ${clip(message, ARG_VALUE_CHARS)}`;
    }
    case "terminate": {
      const reason = str(d, "reason") ?? "?";
      return `${tag(state)} terminate ${reason}`;
    }
    case "run_ended": {
      const reason = str(d, "reason") ?? "?";
      const code = str(d, "code");
      return `${tag(state)} ended ${reason}${code === undefined ? "" : ` (${code})`}`;
    }
    default:
      return null;
  }
}

/**
 * How long a child has been parked on a question, in whole seconds.
 *
 * @returns the age, or `undefined` when it is not waiting.
 */
export function waitAgeSeconds(state: ProjectionState, now: number): number | undefined {
  if (state.waitingSince === undefined) return undefined;
  return Math.max(0, Math.round((now - state.waitingSince) / 1000));
}
