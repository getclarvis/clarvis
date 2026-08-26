import type { TraceHandle } from "@clarvis/trace";
/**
 * Builders of contract-shaped fakes for testing a capability in isolation:
 * an AgentScope and an AgentBuildContext wired to real (cheap) loop
 * primitives, each accepting overrides for the parts a test cares about.
 */
import { createTrace } from "@clarvis/trace";
import { createIterationCounter, createTokenLedger } from "../budget/budget.ts";
import { createLiveContext, DISABLED_COMPACTION } from "../context/context-compaction.ts";
import { createConvergenceGuards } from "../guards/convergence-guards.ts";
import { createToolArgValidator, type ToolArgValidator } from "../tools/tool-arg-validator.ts";
import type { AgentRunState, LoopAgentBuildContext } from "../loop/loop-contract.ts";
import type { AgentScope } from "@clarvis/capability";

/**
 * An {@link AgentScope} for driving `forAgent`: an entry subagent with no
 * grants (and no clock/signal/elicit). `over` shallow-overrides any field.
 */
export function fakeAgentScope(over: Partial<AgentScope> = {}): AgentScope {
  return {
    agent: "subagent",
    entry: true,
    grants: [],
    ...over,
  };
}

/**
 * A {@link LoopAgentBuildContext} whose `trace` is the concrete
 * {@link TraceHandle} the fake builds rather than the narrower port the contract
 * declares.
 *
 * @remarks A test drives a contribution through the contract and then asserts on
 *   what it recorded, which means reading `trace.entries()` — a member the port
 *   deliberately omits because no capability needs it. Widening only the test
 *   helper keeps that assertion available without widening the port.
 */
export type FakeAgentBuildContext = LoopAgentBuildContext & { trace: TraceHandle };

let sharedArgValidator: ToolArgValidator | undefined;

/**
 * The engine's real {@link ToolArgValidator}, built once and shared by every
 * fake build context.
 *
 * @remarks Memoized rather than constructed per call because each one carries
 *   its own Ajv instance and compiled-schema cache, and rather than built at
 *   module load because importing this helper must not pay for one.
 */
function fakeArgValidator(): ToolArgValidator {
  sharedArgValidator ??= createToolArgValidator();
  return sharedArgValidator;
}

/**
 * An {@link AgentBuildContext} for driving a contribution's `attach`, wired to
 * real but cheap loop primitives (an in-memory trace, disabled-compaction live
 * context, generous token/iteration budgets, fresh convergence guards, and the
 * engine's real argument validator). `over` shallow-overrides any field.
 *
 * @remarks `validateArgs` is set because production always sets it (`runAgent`
 *   threads `argValidator.validate` onto every build context) and
 *   `openCallEnvelope` *throws* when a handler supplies a `schema` without one.
 *   A fake omitting it therefore makes every schema-carrying tool — `ask_user`,
 *   `load_skill` — unreachable from a capability test, valid arguments included,
 *   and `validateArgs?` being optional on the contract means TypeScript cannot
 *   report it. It is placed before the `over` spread so a test may still
 *   substitute its own.
 */
export function fakeAgentBuildContext(
  over: Partial<FakeAgentBuildContext> = {},
): FakeAgentBuildContext {
  const state: AgentRunState = { lastAssistantText: "" };
  return {
    agent: "subagent",
    ctx: createLiveContext([], DISABLED_COMPACTION, { agent: "subagent" }),
    state,
    trace: createTrace(),
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(100),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    guards: createConvergenceGuards(),
    toolProgress: (r) => r.errText === null,
    maybeCancelled: () => null,
    validateArgs: fakeArgValidator().validate,
    ...over,
  };
}
