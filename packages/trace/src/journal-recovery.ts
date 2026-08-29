import type { PerAgentUsage, RunResponse, Usage } from "@clarvis/capability";
import { isBuiltinTraceEvent } from "@clarvis/capability";
import type { ExecutionRecord, Trace, TraceEvent } from "@clarvis/capability";
import { hostname } from "node:os";
import type { JournalHeader } from "./journal.ts";
import { JOURNAL_VERSION } from "./journal.ts";

/**
 * The text a synthetic `tool_call` carries when the process died before the
 * real result arrived.
 *
 * @remarks The crash-path analogue of the filler `runDispatch` writes when a
 * dispatch is cut short, and it exists for the same reason: a `tool_use` with
 * no `tool_result` is a conversation shape providers reject, so a recovered
 * trace must not contain one.
 */
export const UNCOMPLETED_TOOL_RESULT = (name: string): string =>
  `Tool '${name}' was not completed (the process ended before its result).`;

/** A journal whose header could not be folded, and why. */
export interface JournalParseFailure {
  ok: false;
  /** Why the journal is unusable; always a header problem. */
  reason: "empty" | "bad_header";
}

/** A journal stopped before parsing could allocate beyond a recovery bound. */
export interface JournalParseLimitFailure {
  ok: false;
  reason: "limit";
  limit: "chars" | "line_chars" | "events";
}

/** A successfully folded journal. */
export interface JournalParseSuccess {
  ok: true;
  header: JournalHeader;
  events: TraceEvent[];
  /** Lines skipped because they were unparseable or not objects. */
  skipped: number;
}

/** The outcome of in-memory or incremental journal parsing. */
export type JournalParseResult =
  JournalParseSuccess | JournalParseFailure | JournalParseLimitFailure;

/** Bounds applied while an orphan journal is read incrementally. */
export interface JournalParseLimits {
  maxChars: number;
  maxLineChars: number;
  maxEvents: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the process that opened a journal is still running.
 *
 * @param header - the parsed journal header.
 * @returns `true` only when the writer is provably alive on *this* host.
 * @remarks Answers "no" for a journal from another host, or one with no writer
 * recorded, because a pid is meaningless off its own machine and guessing would
 * be worse than the age heuristic it supplements. `kill(pid, 0)` sends no
 * signal; it only asks whether the pid exists. An `EPERM` means it exists and
 * belongs to someone else — still alive, so still not ours to recover.
 */
export function writerStillRunning(header: JournalHeader): boolean {
  const writer = header.writer;
  if (writer === undefined || writer.host !== hostname()) return false;
  /**
   * Our own pid is never evidence. A journal this process still holds open is
   * already excluded by the store's live set; one it has closed is a run that
   * ended unpersisted and is exactly what recovery is for — so treating "the
   * writer is me" as "still running" would make those unrecoverable for the
   * lifetime of the process.
   */
  if (writer.pid === process.pid) return false;
  try {
    process.kill(writer.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseHeader(line: string): JournalHeader | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { v, id, owner_key_name, started_at, request } = raw;
  if (typeof v !== "number" || v > JOURNAL_VERSION) return null;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof owner_key_name !== "string" || owner_key_name.length === 0) return null;
  if (typeof started_at !== "number" || !Number.isFinite(started_at)) return null;
  /**
   * `request` is validated as *present and an object*, not against the request
   * schema. Recovery must not reject a journal because a request shape changed
   * under it, but every consumer reads `record.request.*`, so an absent one
   * would be a dereference waiting to happen rather than a lenient read.
   */
  if (!isRecord(request)) return null;
  const writer = raw.writer;
  const hostMetadata = raw.host_metadata;
  return {
    v,
    id,
    owner_key_name,
    started_at,
    request: request as unknown as JournalHeader["request"],
    ...(isRecord(hostMetadata) ? { host_metadata: hostMetadata } : {}),
    ...(isRecord(writer) && typeof writer.pid === "number" && typeof writer.host === "string"
      ? { writer: { pid: writer.pid, host: writer.host } }
      : {}),
  };
}

/**
 * Parse a journal's raw text into its header and event list.
 *
 * @param text - the whole journal file.
 * @returns the folded header and events, or a failure naming the header problem.
 * @remarks Leniency is deliberate and asymmetric. A **trailing** partial line is
 *   expected after a crash - the process died mid-`write` - so it is dropped
 *   without comment. An unparseable line in the middle, or one that is not a
 *   JSON object, is counted in `skipped` rather than failing the whole journal:
 *   losing one event is strictly better than losing the run. Events whose
 *   `type` this build does not recognise are kept verbatim, so a journal
 *   written by a newer build still recovers.
 */
function createJournalLineParser(maxEvents: number): {
  push: (line: string, trailing: boolean) => JournalParseResult | undefined;
  finish: () => JournalParseResult;
} {
  let header: JournalHeader | undefined;
  const events: TraceEvent[] = [];
  let skipped = 0;
  let terminal: JournalParseResult | undefined;

  const push = (line: string, trailing: boolean): JournalParseResult | undefined => {
    if (terminal !== undefined) return terminal;
    if (line.trim().length === 0) return undefined;
    if (header === undefined) {
      const parsed = parseHeader(line);
      if (parsed === null) terminal = { ok: false, reason: "bad_header" };
      else header = parsed;
      return terminal;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (!trailing) skipped += 1;
      return undefined;
    }
    if (!isRecord(raw) || typeof raw.type !== "string") {
      skipped += 1;
      return undefined;
    }
    if (events.length >= maxEvents) {
      terminal = { ok: false, reason: "limit", limit: "events" };
      return terminal;
    }
    events.push(raw as unknown as TraceEvent);
    return undefined;
  };

  return {
    push,
    finish(): JournalParseResult {
      if (terminal !== undefined) return terminal;
      if (header === undefined) return { ok: false, reason: "empty" };
      return { ok: true, header, events, skipped };
    },
  };
}

/**
 * Parse a journal stream with aggregate, line and event limits.
 *
 * @remarks Chunks are accumulated as parts and joined once per line. This keeps
 * memory O(largest bounded line + bounded events), instead of materializing the
 * whole file plus `split()`'s line array before JSON parsing begins.
 */
export async function parseJournalChunks(
  chunks: AsyncIterable<string>,
  limits: JournalParseLimits,
): Promise<JournalParseResult> {
  const parser = createJournalLineParser(limits.maxEvents);
  let totalChars = 0;
  let lineChars = 0;
  let parts: string[] = [];

  for await (const chunk of chunks) {
    totalChars += chunk.length;
    if (totalChars > limits.maxChars) return { ok: false, reason: "limit", limit: "chars" };
    let cursor = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", cursor);
      if (newline < 0) break;
      const part = chunk.slice(cursor, newline);
      lineChars += part.length;
      if (lineChars > limits.maxLineChars) {
        return { ok: false, reason: "limit", limit: "line_chars" };
      }
      parts.push(part);
      const failed = parser.push(parts.join(""), false);
      if (failed !== undefined) return failed;
      parts = [];
      lineChars = 0;
      cursor = newline + 1;
    }
    const tail = chunk.slice(cursor);
    if (tail.length > 0) {
      lineChars += tail.length;
      if (lineChars > limits.maxLineChars) {
        return { ok: false, reason: "limit", limit: "line_chars" };
      }
      parts.push(tail);
    }
  }

  if (parts.length > 0) {
    const failed = parser.push(parts.join(""), true);
    if (failed !== undefined) return failed;
  }
  return parser.finish();
}

function eventTime(event: TraceEvent): number | undefined {
  const e = event as unknown as Record<string, unknown>;
  for (const key of ["ended_at", "occurred_at", "started_at", "spawned_at"]) {
    const value = e[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Append a synthetic `tool_call` for every `tool_call_started` the journal never
 * settled.
 *
 * @param events - the folded events, in recorded order.
 * @returns the events with repairs appended in the order their calls started.
 * @remarks Pairing is by `call_id`, which every recorder in the engine shares.
 *   A `tool_call` with no preceding `tool_call_started` needs no repair and is
 *   left alone - only the unsettled direction breaks the conversation. A
 *   capability-contributed event ({@link isBuiltinTraceEvent} rejects it)
 *   carries no `call_id` pairing at all and is skipped outright.
 */
export function repairUnsettledToolCalls(events: TraceEvent[]): TraceEvent[] {
  const started = new Map<string, Extract<TraceEvent, { type: "tool_call_started" }>>();
  const settled = new Set<string>();
  for (const event of events) {
    if (!isBuiltinTraceEvent(event)) continue;
    if (event.type === "tool_call_started") started.set(event.call_id, event);
    else if (event.type === "tool_call" && event.call_id !== undefined) settled.add(event.call_id);
  }
  const repairs: TraceEvent[] = [];
  for (const [callId, open] of started) {
    if (settled.has(callId)) continue;
    const name = open.tool_name.length > 0 ? `${open.mcp_name}.${open.tool_name}` : open.mcp_name;
    const text = UNCOMPLETED_TOOL_RESULT(name);
    repairs.push({
      type: "tool_call",
      agent: open.agent,
      ...(open.subagent_instance_id !== undefined
        ? { subagent_instance_id: open.subagent_instance_id }
        : {}),
      call_id: callId,
      iteration_ref: open.iteration_ref,
      started_at: open.started_at,
      ended_at: open.started_at,
      mcp_name: open.mcp_name,
      tool_name: open.tool_name,
      arguments: open.arguments,
      result: text,
      error: text,
    });
  }
  return repairs.length === 0 ? events : [...events, ...repairs];
}

function sumUsage(events: TraceEvent[]): { usage: Usage; lastAt: number | undefined } {
  const lead = new Map<string, PerAgentUsage & { type: "lead" }>();
  const sub = new Map<string, PerAgentUsage & { type: "subagent" }>();
  const subInstances = new Map<string, Set<string>>();
  let iterations = 0;
  let lastAt: number | undefined;
  let spawned = 0;

  for (const event of events) {
    const at = eventTime(event);
    if (at !== undefined && (lastAt === undefined || at > lastAt)) lastAt = at;
    if (!isBuiltinTraceEvent(event)) continue;

    if (event.type === "delegation_created") spawned += 1;
    else if (event.type === "lead_iteration") {
      iterations += 1;
      const row = lead.get(event.model) ?? {
        type: "lead",
        model: event.model,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 0,
        subagents_spawned: 0,
      };
      row.input_tokens += event.input_tokens;
      row.output_tokens += event.output_tokens;
      row.cached_tokens += event.cached_tokens;
      row.cache_write_tokens += event.cache_write_tokens;
      row.iterations += 1;
      lead.set(event.model, row);
    } else if (event.type === "subagent_iteration") {
      const row = sub.get(event.model) ?? {
        type: "subagent",
        model: event.model,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 0,
      };
      row.input_tokens += event.input_tokens;
      row.output_tokens += event.output_tokens;
      row.cached_tokens += event.cached_tokens;
      row.cache_write_tokens += event.cache_write_tokens;
      row.iterations = (row.iterations ?? 0) + 1;
      sub.set(event.model, row);
      const seen = subInstances.get(event.model) ?? new Set<string>();
      seen.add(event.subagent_instance_id);
      subInstances.set(event.model, seen);
    }
  }

  for (const [model, row] of sub) row.instances = subInstances.get(model)?.size ?? 0;
  /**
   * The spawn total is a run-level figure, so it is attributed to a single lead
   * row. Assigning it to every row would multiply it by the number of lead
   * models a run happened to use, and the aggregate would then double-count.
   */
  const leadRows = [...lead.values()];
  if (leadRows.length > 0) leadRows[0]!.subagents_spawned = spawned;

  return {
    usage: {
      iterations_used: iterations,
      elapsed_ms: 0,
      by_agent: [...lead.values(), ...sub.values()],
    },
    lastAt,
  };
}

/**
 * Fold a parsed journal into the {@link ExecutionRecord} a crashed run never got
 * to write.
 *
 * @param parsed - the journal's header and events.
 * @returns a record with `status: "interrupted"`, token totals summed from the
 *   journal's per-iteration events, and unsettled tool calls repaired.
 * @remarks An
 *   {@link import("@clarvis/capability").ExecutionRecovery | ExecutionRecovery}
 *   is attached only when something was actually lost or synthesized, so its
 *   absence keeps meaning "this record is intact" for a run whose journal parsed
 *   cleanly and settled every call.
 *
 *   The record deliberately carries **no `final_context`**. That snapshot
 *   is built from the live context at teardown and is not derivable from trace
 *   events, so `continue_from` against a recovered run still fails. Recovery
 *   restores the audit trail and the accounting; it does not restore
 *   resumability, and claiming otherwise would be a half-truth discovered only
 *   at the moment someone needed it.
 */
export function journalToRecord(parsed: JournalParseSuccess): ExecutionRecord {
  const events = repairUnsettledToolCalls(parsed.events);
  const synthesized = events.length - parsed.events.length;
  const { usage, lastAt } = sumUsage(events);
  const startedAt = parsed.header.started_at;
  const elapsedMs = lastAt !== undefined ? Math.max(0, lastAt - startedAt) : 0;
  usage.elapsed_ms = elapsedMs;

  const response: RunResponse = { status: "interrupted", result: undefined, usage };
  const trace: Trace = { events };

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCacheWrite = 0;
  for (const agent of usage.by_agent) {
    totalInput += agent.input_tokens;
    totalOutput += agent.output_tokens;
    totalCached += agent.cached_tokens;
    totalCacheWrite += agent.cache_write_tokens;
  }

  return {
    id: parsed.header.id,
    owner_key_name: parsed.header.owner_key_name,
    status: "interrupted",
    started_at: startedAt,
    ended_at: startedAt + elapsedMs,
    elapsed_ms: elapsedMs,
    request: parsed.header.request,
    response,
    trace,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cached_tokens: totalCached,
    total_cache_write_tokens: totalCacheWrite,
    ...(parsed.header.host_metadata === undefined
      ? {}
      : { host_metadata: parsed.header.host_metadata }),
    ...(parsed.skipped > 0 || synthesized > 0
      ? { recovery: { skipped_lines: parsed.skipped, synthesized_tool_calls: synthesized } }
      : {}),
  };
}
