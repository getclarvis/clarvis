import { randomUUID } from "node:crypto";
import type { EnvConfig, TracePort } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type {
  CompactionSource,
  ImagePart,
  RunRequest,
  SteerSource,
  LifecycleHook,
} from "@clarvis/capability";
import type { RunContinuation } from "@clarvis/capability";
import type { TokenAccumulator } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import type { NamespacedRegistry } from "@clarvis/capability";
import { buildRegistry, selectTools } from "./tools/mcp-registry.ts";
import type { OpenedConnection } from "@clarvis/mcp-client";
import type { IterationCounter, TokenLedger } from "./budget/budget.ts";
import {
  createSoftBudget,
  buildSoftLimitAsk,
  type SoftBudget,
  type SoftLimitAsk,
} from "./budget/soft-budget.ts";
import { buildGuardEscalationAsk } from "./guards/guard-escalation.ts";
import type { LiveContext, LiveSeedEntry } from "./context/context-compaction.ts";
import { createToolSpill } from "./context/tool-spill.ts";
import type { Semaphore } from "./support/concurrency.ts";
import type { ComputeClock } from "@clarvis/capability";
import { toLlmTarget } from "./loop/loop-shared.ts";
import type { RunAgentInput } from "./loop/run-agent.ts";
import type { Elicit } from "./tools/ask-user-tool.ts";
import type {
  AgentScope,
  CapabilityEventListener,
  CapabilityServices,
  RunCapability,
} from "@clarvis/capability";
import { capabilitiesForScope } from "@clarvis/capability";
import { agentToolsActive } from "./tools/builtin/grants.ts";
import { createDelegationRunCapability } from "./capabilities/delegation.ts";
import { orderCapabilities } from "./capability-order.ts";
import { createAgentsRunCapability } from "./capabilities/agents.ts";
import { AGENT_REGISTRY_PORT, resolveAgentsLimits } from "@clarvis/supervision";
import type { ResultContract } from "./tools/result-contract.ts";
import { buildSubagentInputPersona, userText } from "./subagents/build-subagent-input.ts";
import { buildLeadInputPersona } from "./subagents/build-lead-input.ts";
import type { SubagentAggregate } from "./subagents/delegate-task.ts";
import type { RunShape } from "./run-shape.ts";

/**
 * The run-scoped dependencies {@link createEntryInput} threads into the entry
 * agent's loop input: environment, workspace, LLM, the optional elicit/steer/hook
 * channels, the result contract, a resume `continuation`, and the run's activated
 * capabilities and capability-event listener.
 */
export interface EntryInputDeps {
  env: EnvConfig;
  workspaceRoot: string;
  executionId?: string;
  llm: LLMProvider;
  elicit?: Elicit;
  steer?: SteerSource;
  compaction?: CompactionSource;
  hooks?: LifecycleHook[];
  logger?: Logger;
  resultContract?: ResultContract;
  continuation?: RunContinuation;
  runCapabilities?: readonly RunCapability[];
  emitCapabilityEvent?: CapabilityEventListener;
  /** The run's inter-capability port registry. */
  services?: CapabilityServices;
  /**
   * Wire names the run's registered capabilities own, reserved against MCP in
   * every registry this builder mints — the lead's spawnable-tool registry
   * included, which is a separate one from the entry agent's.
   */
  capabilityReserved?: readonly string[];
}

/**
 * The full set of collaborators {@link createEntryInput} closes over to build the
 * entry agent's per-turn input: the request/shape/deps, the tool registry and
 * opened pool, the budget ledger/counter/usage, the entry iteration cap, the seed
 * messages and turn images, the subagent semaphore and per-model aggregates, and
 * the `onContext` capture sink.
 */
export interface EntryInputParams {
  request: RunRequest;
  deps: EntryInputDeps;
  shape: RunShape;
  trace: TracePort;
  registry: NamespacedRegistry;
  opened: OpenedConnection[];
  ledger: TokenLedger;
  counter: IterationCounter;
  entryUsage: TokenAccumulator;
  entryMax: number;
  entryMessages: LiveSeedEntry[];
  turnImages: ImagePart[];
  semaphore?: Semaphore;
  subagentAggByModel: Map<string, SubagentAggregate>;
  onContext: (ctx: LiveContext) => void;
  /** The run's usage-warnings sink, forwarded to the entry agent's build context. */
  warnings: string[];
}

/**
 * Builds the concrete {@link RunAgentInput} for one loop attempt, given the
 * attempt's compute `clock` and cancellation `signal`.
 *
 * @remarks Called once per timeout/clock attempt so each attempt gets a fresh
 *   clock- and signal-bound input (budgets, elicit waits, capability scopes).
 */
export type EntryInputBuilder = (
  clock: ComputeClock,
  signal: AbortSignal | undefined,
) => RunAgentInput;

/**
 * Build the soft budget and its escalation ask for the entry agent, but only in
 * soft mode.
 *
 * @returns `[softBudget, softLimitAsk]`, or `[undefined, undefined]` when not in
 *   soft mode or when no soft limits are configured.
 * @remarks In soft mode the entry agent's elicit channel is required and used to
 *   raise the human when a soft limit is reached (`buildSoftLimitAsk`).
 */
function buildFinalizerSoftBudget(
  request: RunRequest,
  softMode: boolean,
  deps: EntryInputDeps,
  clock: ComputeClock,
  signal: AbortSignal | undefined,
  finalizerSoftIter: number,
): [SoftBudget | undefined, SoftLimitAsk | undefined] {
  if (!softMode) return [undefined, undefined];
  const softBudget = createSoftBudget({
    ...(request.budget.total_token_limit !== undefined
      ? { softTokenLimit: request.budget.total_token_limit }
      : {}),
    softIterationLimit: finalizerSoftIter,
    maxEscalations: request.budget.max_escalations ?? deps.env.CLARVIS_DEFAULT_MAX_ESCALATIONS,
  });
  if (softBudget === undefined) return [undefined, undefined];
  const elicitWaitMs = request.elicit_wait_ms ?? deps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS;
  return [softBudget, buildSoftLimitAsk(deps.elicit!, clock, signal, elicitWaitMs)];
}

/**
 * Assemble the per-attempt input builder for the entry agent — lead or subagent —
 * wiring its capabilities, budget, compaction, persona and tool registry.
 *
 * @param p - the run's collaborators; see {@link EntryInputParams}.
 * @returns an {@link EntryInputBuilder} producing a role-appropriate
 *   {@link RunAgentInput} for each clock/signal-bound attempt.
 * @remarks A lead gains the delegation run-capability on top of the run's own;
 *   a plain subagent gets only the run's. The whole list is then ordered by each
 *   capability's declared `order`, which is what lets a capability guarantee its
 *   handlers are consulted first. A subagent's task body is the user text of
 *   the request; a lead's is empty. The returned builder dispatches to the lead or
 *   subagent input shape per call.
 */
export function createEntryInput(p: EntryInputParams): EntryInputBuilder {
  const { request, deps, shape, trace, registry, opened, ledger, counter } = p;
  const { entryProfile, entryResolved, isLead } = shape;

  const elicitWaitMs = request.elicit_wait_ms ?? deps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS;
  const subagentInstanceId = isLead ? undefined : (request.agent_instance_id ?? randomUUID());
  const subagentTaskBody = isLead ? "" : userText(request.messages);
  const entryHasBuiltins = agentToolsActive(deps.env, entryProfile.grants);
  const spillToolResult = createToolSpill(deps.workspaceRoot, deps.logger);
  const agents = deps.services?.get(AGENT_REGISTRY_PORT);

  const entryRunCaps: readonly RunCapability[] = isLead
    ? [
        createDelegationRunCapability({
          env: deps.env,
          workspaceRoot: deps.workspaceRoot,
          opened,
          profiles: shape.spawnableRegistry,
          ...(entryProfile.default_spawn !== undefined
            ? { defaultProfile: entryProfile.default_spawn }
            : {}),
          iterationLimitDefault: deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT,
          llm: deps.llm,
          ledger,
          subagentAggByModel: p.subagentAggByModel,
          semaphore: p.semaphore!,
          ...(agents !== undefined ? { agents } : {}),
          canDelegate: isLead,
          ...(deps.services === undefined ? {} : { services: deps.services }),
          ...(deps.elicit ? { elicit: deps.elicit } : {}),
          ...(deps.runCapabilities !== undefined ? { runCapabilities: deps.runCapabilities } : {}),
          ...(deps.hooks ? { hooks: deps.hooks } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
          ...(p.turnImages.length > 0 ? { turnImages: p.turnImages } : {}),
          ...(deps.emitCapabilityEvent === undefined
            ? {}
            : { emitCapabilityEvent: deps.emitCapabilityEvent }),
          ...(deps.capabilityReserved === undefined
            ? {}
            : { capabilityReserved: deps.capabilityReserved }),
        }),
        ...(deps.runCapabilities ?? []),
      ]
    : (deps.runCapabilities ?? []);

  const ordered = orderCapabilities(entryRunCaps);

  const agentsLimits = agents === undefined ? undefined : resolveAgentsLimits(request, deps.env);
  const entryCapsWithAgents: readonly RunCapability[] =
    agents === undefined || agentsLimits === undefined
      ? ordered
      : [
          createAgentsRunCapability(agents, agentsLimits.awaitTimeoutMs, agentsLimits.finishNudges),
          ...ordered,
        ];
  const buildSharedInput = (clock: ComputeClock, signal: AbortSignal | undefined) => {
    const entryScope: AgentScope = {
      agent: isLead ? "lead" : "subagent",
      entry: true,
      grants: entryProfile.grants ?? [],
      clock,
      ...(signal ? { signal } : {}),
      ...(deps.elicit ? { elicit: deps.elicit } : {}),
    };
    const agentCapabilities = capabilitiesForScope(entryCapsWithAgents, entryScope);
    const [softBudget, softLimitAsk] = buildFinalizerSoftBudget(
      request,
      shape.softMode,
      deps,
      clock,
      signal,
      entryResolved.iterationLimit ?? deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT,
    );
    return {
      messages: p.entryMessages,
      target: toLlmTarget(deps.llm, entryResolved),
      clock,
      budget: {
        ledger,
        counter,
        usage: p.entryUsage,
        ...(softBudget ? { softBudget } : {}),
        ...(softLimitAsk ? { softLimitAsk } : {}),
      },
      runtime: { trace, ...(signal ? { signal } : {}) },
      compaction: entryResolved.compaction,
      ...(entryResolved.compactionPrompt !== undefined
        ? { compactionPrompt: entryResolved.compactionPrompt }
        : {}),
      spillToolResult,
      registry,
      stagnationThreshold: entryResolved.stagnationThreshold,
      forceToolOnNudge:
        entryProfile.orchestration?.force_tool_on_nudge ??
        deps.env.CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE,
      stagnationSoftThreshold: deps.env.CLARVIS_DEFAULT_STAGNATION_SOFT_THRESHOLD,
      ...(request.guard_escalation === true && deps.elicit !== undefined
        ? {
            guardEscalationAsk: buildGuardEscalationAsk(deps.elicit, clock, signal, elicitWaitMs),
            guardMaxEscalations: deps.env.CLARVIS_GUARD_MAX_ESCALATIONS,
          }
        : {}),
      ...(deps.resultContract ? { contract: deps.resultContract } : {}),
      ...(agentCapabilities.length > 0 ? { agentCapabilities } : {}),
      ...(deps.steer ? { steer: deps.steer } : {}),
      ...(deps.compaction ? { compactionSource: deps.compaction } : {}),
      ...(deps.hooks ? { hooks: deps.hooks } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      onContext: p.onContext,
      warnings: p.warnings,
    };
  };

  const buildSubagentInput = (
    clock: ComputeClock,
    signal: AbortSignal | undefined,
  ): RunAgentInput => ({
    ...buildSharedInput(clock, signal),
    agent: "subagent",
    ...(subagentInstanceId !== undefined ? { subagentInstanceId } : {}),
    ...buildSubagentInputPersona({
      registry,
      subagentTaskBody,
      subagentInstanceId: subagentInstanceId ?? "",
      model: entryResolved.model,
      trace,
      hasBuiltinTools: entryHasBuiltins,
    }),
  });

  const buildLeadInput = (clock: ComputeClock, signal: AbortSignal | undefined): RunAgentInput => {
    const spawnable = [...shape.spawnableRegistry.values()];
    return {
      ...buildSharedInput(clock, signal),
      agent: "lead",
      ...buildLeadInputPersona({
        registry,
        entryMax: p.entryMax,
        softMode: shape.softMode,
        leadHasBuiltins: entryHasBuiltins,
        subagentsHaveBuiltins: spawnable.some((pp) => agentToolsActive(deps.env, pp.grants)),
        buildSubagentRegistry: () =>
          buildRegistry(
            selectTools(
              opened,
              spawnable.flatMap((pp) => pp.tools),
            ),
            deps.capabilityReserved ?? [],
          ),
      }),
    };
  };

  return (clock, signal) =>
    isLead ? buildLeadInput(clock, signal) : buildSubagentInput(clock, signal);
}
