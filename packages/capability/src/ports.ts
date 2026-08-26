import type { TraceDetailFor, TraceKind } from "./trace-kinds.ts";

/**
 * The narrow ports a capability is written against, so the contract can name
 * what a capability *uses* without importing the engine that implements it.
 *
 * @remarks Each port is deliberately the measured minimum. The loop's rich
 * `LiveContext` (~50 members) and `TraceHandle` satisfy {@link ContextPort} and
 * {@link TracePort} structurally — there is no adapter at runtime and no cast.
 * Widening a port is a design decision, not a convenience: every member added
 * here is a member the engine can no longer change freely.
 */

/**
 * One log call. Accepts either a bindings object followed by a message, or a
 * bare message.
 *
 * @remarks Structurally satisfied by pino's `LogFn`, which is how the engine's
 * pino logger is assignable to {@link Logger} without this package depending on
 * pino.
 */
export interface LogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/**
 * The logging port: the four levels a capability actually emits at, plus two
 * optional members a real backend provides and a bare sink may omit.
 *
 * @remarks The engine's `createLogger` (pino) stays in `@clarvis/loop`; only
 * this shape crosses the contract boundary, so a capability never depends on
 * the logging implementation.
 *
 * `trace` and `fatal` are deliberately absent. `CLARVIS_LOG_LEVEL` admits only
 * the four levels below plus `silent`, so a name this port cannot express is a
 * name no configuration can select.
 *
 * @see {@link ./log.ts} for `NOOP_LOGGER`, `bind` and `levelEnabled`, which are
 * how a caller uses the two optional members without testing for them.
 */
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /**
   * Derive a logger that stamps `bindings` onto every record it writes.
   *
   * @param bindings - fields to add to this logger's own.
   * @returns the derived logger.
   * @remarks Optional because a minimal sink need not implement it; reach it
   *   through `bind`, which falls back to the undecorated logger. It is what
   *   makes a run's `execution_id` reach a line emitted six frames deeper
   *   without every signature between them carrying it.
   */
  child?(bindings: Record<string, unknown>): Logger;
  /**
   * The level below which this logger discards a record.
   *
   * @remarks Typed `string` rather than a narrow union on purpose: pino types
   *   its own `level` as `string`, and narrowing here would cost the structural
   *   assignability that is this port's whole reason to exist. Read it through
   *   `levelEnabled`, which parses it and treats an unrecognized or absent
   *   value as "emit".
   *
   *   It exists because a bindings object is allocated **at the call site**,
   *   before any backend sees the level — so a hot-path `debug` costs its
   *   payload even at `silent`. This is the only way to guard that.
   */
  readonly level?: string;
}

/**
 * What a capability uses of the live transcript.
 *
 * @remarks Satisfied by the loop's `LiveContext`. The three members are the
 * measured union across every capability: `appendNote` (the agents capability's
 * child notices) and the two setters (the plans capability's canonical state).
 */
export interface ContextPort {
  /** Append a runtime note to the transcript as a distinct entry. */
  appendNote(content: string): void;
  /** Install or replace a pinned, non-evictable block identified by `kind`. */
  setStableBlock(kind: string, content: string): void;
  /** Replace the run's canonical-state block, re-rendered each iteration. */
  setCanonicalState(content: string): void;
}

/**
 * What a capability uses of the run trace.
 *
 * @remarks Satisfied by the loop's `TraceHandle`. `kind` is `string` rather than
 * the built-in union so a capability living outside the engine can record its
 * own trace kinds without the engine declaring them; see `./trace` for the
 * built-in vocabulary and its exact detail types.
 */
export interface TracePort {
  /**
   * Record one durable trace entry.
   *
   * @remarks Generic over {@link TraceKind}, so a built-in kind still has its
   * detail shape checked at the call site while a kind contributed by a
   * capability the engine does not declare is accepted with a detail of
   * `unknown`. Keeping the precise signature here rather than a loose
   * `(kind: string, detail: unknown)` is what lets the engine's own loop write
   * through this port without losing type-checking on any of its ~38 kinds.
   */
  record<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void;
  /**
   * Emit a live-only entry: it reaches a watching UI but is never persisted.
   *
   * @remarks For high-frequency progress whose durable form a later
   * {@link TracePort.record} already captures — a tool streaming its output is
   * the motivating case.
   */
  signal<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void;
  /**
   * Run-relative time in milliseconds since the trace's start origin.
   *
   * @remarks Present because a contribution's tool calls are timed through the
   * engine's shared call envelope, which stamps `started_at`/`ended_at` off this
   * clock. A capability rarely calls it directly, but every capability that
   * contributes a tool reaches it by handing its build context to the envelope.
   */
  now(): number;
}

export type {
  Elicit,
  ElicitParams,
  ElicitRawResult,
  ElicitRequestedSchema,
  ElicitationAction,
  ElicitationOutcome,
} from "./elicit.ts";
export type { AgentRegistryPort } from "./agents-port.ts";
export type { LLMProvider, ToolChoice } from "./llm-port.ts";
