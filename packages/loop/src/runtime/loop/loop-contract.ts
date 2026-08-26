import type {
  AgentBuildContext,
  AgentResult,
  FinalizeAttempt,
  FinalizeGate,
  GateOutcome,
  HandlerVerdict,
  LLMToolCall,
  ToolHandler,
  TracePort,
} from "@clarvis/capability";
import type { LiveContext } from "../context/context-compaction.ts";
import type { LoopBudget } from "./loop-shared.ts";

export type {
  AgentBuildContext,
  AgentRunState,
  FinalizeAttempt,
  FinalizeGate,
  GateOutcome,
  HandlerResult,
  HandlerVerdict,
  OrchestrationHooks,
  ToolHandler,
} from "@clarvis/capability";

/**
 * The engine's own build context: the capability {@link AgentBuildContext} plus
 * the two members only the loop itself needs.
 *
 * @remarks The contract deliberately names `ctx` as a narrow port and
 *   omits the budget entirely, because no capability reads any of that. The loop
 *   does — it builds the object, and its lead persona charges the budget — so it
 *   widens the same shape here rather than pushing engine types across the
 *   contract. Assignability runs one way, which is the point: everything a
 *   capability is handed satisfies the contract, and only the engine sees the
 *   rest.
 */
export interface LoopAgentBuildContext extends AgentBuildContext {
  ctx: LiveContext;
  trace: TracePort;
  budget: LoopBudget;
}

/**
 * A terminal {@link HandlerVerdict} that may carry the model-facing result text
 * for the very call that ended the agent.
 *
 * @remarks The call did run, so the dispatch has to record *its* outcome rather
 *   than the `was not completed` fill reserved for calls the batch never reached.
 *   A handler that already framed and traced its result — the `submit_result`
 *   handler does, through a `CallEnvelope` — hands the exact string over in
 *   `text` so the persisted context and the trace cannot disagree about one call.
 *   A producer that supplies nothing still never fabricates a failure: the loop
 *   derives a truthful line from `result` instead.
 */
export interface EngineTerminalVerdict {
  kind: "terminal";
  result: AgentResult;
  text?: string;
}

/**
 * The engine's own verdict union: the capability {@link HandlerVerdict} with its
 * terminal arm widened to {@link EngineTerminalVerdict}.
 *
 * @remarks Assignability runs one way, as with {@link LoopAgentBuildContext}:
 *   every verdict a capability returns satisfies this type, and only handlers the
 *   engine itself builds populate `text`. Keeping the widening here rather than in
 *   `@clarvis/capability` leaves the published port unchanged — every terminal
 *   verdict in the monorepo is produced inside this package.
 */
export type EngineHandlerVerdict =
  Exclude<HandlerVerdict, { kind: "terminal" }> | EngineTerminalVerdict;

/**
 * Find the first handler that claims a given tool call.
 *
 * @param handlers - the ordered handler list; earlier handlers win.
 * @param call - the tool call to route.
 * @returns the first {@link ToolHandler} whose `matches` returns `true`, or
 *   `undefined` when none claim the call.
 */
export function selectHandler(
  handlers: ReadonlyArray<ToolHandler>,
  call: LLMToolCall,
): ToolHandler | undefined {
  return handlers.find((h) => h.matches(call));
}

/**
 * Run finalize gates in order, short-circuiting on the first non-pass ruling.
 *
 * @param gates - the ordered gates; earlier gates rule first.
 * @param attempt - the finalize attempt under review.
 * @returns the first non-`pass` {@link GateOutcome} with the ordinal of the gate
 *   that produced it, or `pass` with `-1` when every gate allows the attempt.
 * @remarks The ordinal is the gate's only identity: {@link FinalizeGate} carries
 *   no name, and a run's gates are folded from its capabilities in registration
 *   order, so the position is stable for the life of the run and is what tells
 *   an operator *which* gate is holding a nudge loop open.
 */
export async function runGates(
  gates: ReadonlyArray<FinalizeGate>,
  attempt: FinalizeAttempt,
): Promise<{ outcome: GateOutcome; gate: number }> {
  for (let index = 0; index < gates.length; index += 1) {
    const outcome = await gates[index]!.check(attempt);
    if (outcome.kind !== "pass") return { outcome, gate: index };
  }
  return { outcome: { kind: "pass" }, gate: -1 };
}
