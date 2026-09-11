import type { AgentResult } from "./agent-result.ts";
import type { CheckpointMetadata } from "./finalization.ts";
import type { ComputeClock } from "./compute-clock.ts";
import type { ConvergenceGuards } from "./convergence-guards.ts";
import type { LLMToolCall } from "./llm-port.ts";
import type { ContextPort, TracePort } from "./ports.ts";
import type { AgentRole, HandlerResult } from "./api.ts";

export type { HandlerResult };

/**
 * Validates a tool call's arguments against a JSON Schema.
 *
 * @param schema - the tool's declared input schema.
 * @param args - the arguments the model produced.
 * @returns a human-readable message naming the first violation, or `null` when
 *   the arguments satisfy the schema.
 * @remarks A port rather than a shared helper because the implementation is an
 *   ajv instance, and this package deliberately carries no JSON Schema
 *   dependency — the engine owns one and hands it down through
 *   {@link AgentBuildContext}.
 */
export type ToolArgValidate = (schema: Record<string, unknown>, args: unknown) => string | null;

/**
 * The mutable per-agent state threaded through an iteration: the model's most
 * recent assistant `lastAssistantText`, and the `lastSubmitAttempt` retained so a
 * rejected structured submit can still be surfaced as a partial result.
 */
export interface AgentRunState {
  lastAssistantText: string;
  lastSubmitAttempt?: { value: unknown };
}

/**
 * Everything a capability needs to build its tool handlers and gates for one
 * agent scope: the agent identity, the live conversation {@link ContextPort},
 * the mutable {@link AgentRunState}, tracing, the abort signal, the shared
 * {@link ConvergenceGuards}, the persona's progress policy, and a cancellation
 * probe.
 *
 * @remarks The engine's concrete build context is richer than this and satisfies
 * it structurally — notably it also carries the loop budget, which is
 * deliberately absent here because no capability reads it. Adding a member is a
 * widening of the contract: prefer a port over exposing an engine type.
 */
export interface AgentBuildContext {
  agent: AgentRole;
  subagentInstanceId?: string;
  ctx: ContextPort;
  state: AgentRunState;
  trace: TracePort;
  signal?: AbortSignal;
  /** The loop's doom-loop/convergence guards, shared by tool dispatchers. */
  guards: ConvergenceGuards;
  /** The persona's tool-progress policy (whether a dispatch outcome counts). */
  toolProgress: (r: { errText: string | null; productive: boolean }) => boolean;
  /** Validates a tool call's arguments against its declared JSON Schema. A
   * capability that declares a schema on one of its tools must pass this to
   * {@link openCallEnvelope} alongside it. */
  validateArgs?: ToolArgValidate;
  /** Probe returning a terminal cancelled {@link AgentResult}, or `null` if the run is still live. */
  maybeCancelled: () => AgentResult | null;
  /** The run's compute clock, when one is bound. A capability that idles on
   * purpose (waiting on a child) pauses it so the wait does not burn the run's
   * wall-clock budget. */
  clock?: ComputeClock;
  /**
   * Reports whether a user steer is already queued, *without* consuming it.
   *
   * @remarks Present only for an agent with a steer channel. It exists so a
   * capability can idle interruptibly: the loop's steer source is pull-only, so
   * the only way to notice an arrival is to pull — and pulling would swallow the
   * message the loop is about to deliver. The probe buffers instead, leaving
   * delivery to the loop's own drain at the next iteration top.
   */
  steerProbe?: () => boolean;
  /** Mutable sink for run-level warnings folded into the final `Usage`,
   * present when the run tracks one. */
  warnings?: string[];
}

/**
 * A tool handler's ruling on a dispatched call: an immediate `result`, a
 * `deferred` continuation to run (optionally under an abort signal), a
 * `finalize` request that passes through all finalize gates after dispatch,
 * a `terminal` outcome that ends the agent, or `cancelled` when the call was
 * aborted mid-flight. A checkpoint request does not itself accept the stage.
 */
export type HandlerVerdict =
  | ({ kind: "result" } & HandlerResult)
  | { kind: "deferred"; run: (signal?: AbortSignal) => Promise<HandlerResult> }
  | ({ kind: "finalize"; attempt: CheckpointAttempt } & HandlerResult)
  | { kind: "terminal"; result: AgentResult }
  | { kind: "cancelled" };

/**
 * A dispatcher for one family of tool calls: `matches` claims a call, and
 * `handle` executes the claimed call at the given iteration, yielding a
 * {@link HandlerVerdict}.
 */
export interface ToolHandler {
  matches(call: LLMToolCall): boolean;
  /** Stable tool identity for lifecycle consumers when the wire name is projected. */
  canonicalName?(call: LLMToolCall): string | undefined;
  handle(call: LLMToolCall, iteration: number): Promise<HandlerVerdict>;
}

/**
 * An agent's bid to finish: a `text` final answer, a structured `submit`
 * carrying a `value`, or a capability-requested `checkpoint` with a separate
 * bounded handoff. Missing disposition retains the ordinary final-result path.
 */
export type FinalizeAttempt =
  | { mode: "text" | "submit"; disposition?: "final"; value?: unknown; text?: string }
  | CheckpointAttempt;

/** A capability requests a stage ending through the ordinary finalize gates. */
export interface CheckpointAttempt {
  mode: "checkpoint";
  disposition: "checkpoint";
  checkpoint: CheckpointMetadata;
  value?: never;
  text?: never;
}

/**
 * A finalize gate's ruling on a {@link FinalizeAttempt}: `pass` lets it through,
 * `nudge` sends the model back with a `note` (an `unbounded` nudge is exempt from
 * the nudge budget), or `terminal` ends the agent with the given result.
 */
export type GateOutcome =
  | { kind: "pass" }
  | { kind: "nudge"; note: string; unbounded?: boolean }
  | { kind: "terminal"; result: AgentResult };

/**
 * A gate consulted when an agent tries to finalize; `check` rules on the attempt
 * and the optional `fastAcceptOk` reports (without running `check`) whether this
 * gate would trivially pass, letting the loop skip the gate sweep.
 */
export interface FinalizeGate {
  check(attempt: FinalizeAttempt): Promise<GateOutcome>;
  fastAcceptOk?(): boolean;
}

/**
 * Optional callbacks a capability can register to observe the loop's cadence:
 * `beforeIteration` (top of each iteration), `afterDispatch` (after tool
 * dispatch), `contributesProgress` (report whether it made progress this turn),
 * `onFinalizeAccepted` (an agent's finalize was accepted), and `onTeardown` (the
 * agent is winding down).
 *
 * @remarks `beforeIteration` is awaited in contribution order before compaction
 * or inference. It may return an interruption result to stop the stage, never
 * successful completion or a checkpoint that would bypass finalization gates. The engine
 * bounds the whole sweep and retires its signal on completion, timeout or abort;
 * asynchronous hooks must check that signal before publishing delayed work.
 * `onTeardown` may return a promise, which the loop awaits before it
 * resolves. A capability holding work that outlives a dispatch — a background
 * child — has to be able to wind it down while the run's trace, MCP pool and
 * usage accounting are all still open; a fire-and-forget teardown would drop
 * that child's token usage on the floor. Keep it bounded: everything after the
 * loop resolves is waiting on it.
 */
export interface OrchestrationHooks {
  beforeIteration?: (signal?: AbortSignal) => void | AgentResult | Promise<void | AgentResult>;
  afterDispatch?: () => void;
  contributesProgress?: () => boolean;
  onFinalizeAccepted?: (attempt: FinalizeAttempt) => void;
  onTeardown?: () => void | Promise<void>;
}
