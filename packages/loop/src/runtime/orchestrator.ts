import type { EnvConfig } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { bind, HOOKS_CAPABILITY_NAME, levelEnabled, parseModelRef } from "@clarvis/capability";
import type { CompactionSource, RunRequest, SteerSource, LifecycleHook } from "@clarvis/capability";
import type {
  ContextSnapshotEntry,
  ResolvedConfig,
  RunContinuation,
  RunResponse,
  Usage,
} from "@clarvis/capability";
import type { RecordingTrace, TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import type { RunJournal } from "@clarvis/trace";
import type { LLMProvider } from "@clarvis/capability";

import { type ConnectionManager } from "@clarvis/mcp-client";
import { type OpenedConnection } from "@clarvis/mcp-client";
import { buildRegistry, selectTools } from "./tools/mcp-registry.ts";
import { resolveSubagentProfiles, resolveIterationCap } from "./subagents/subagent-profiles.ts";
import { createTokenLedger } from "./budget/budget.ts";
import { createTrace } from "@clarvis/trace";
import type { TraceHandle } from "@clarvis/trace";
import { runAgent } from "./loop/run-agent.ts";
import { fireObservers } from "./loop/lifecycle-hooks.ts";
import { buildEntrySeed } from "./entry-seed.ts";
import { createUsageAccounting } from "./usage-accounting.ts";
import { createSemaphore } from "./support/concurrency.ts";
import { AGENT_REGISTRY_PORT, createAgentRegistry } from "@clarvis/supervision";
import { resolveAgentsLimits } from "@clarvis/supervision";
import { canSpawnChildren } from "./spawn-shape.ts";
import type { ResultContract } from "./tools/result-contract.ts";
import type { ClockHolder } from "@clarvis/capability";
import { withElicitWaitBound, type Elicit } from "./tools/ask-user-tool.ts";
import type {
  Capability,
  CapabilityEventListener,
  CapabilityGrantDeclaration,
  CapabilityRequestView,
  CapabilityServices,
  PersistedTraceProjectorRegistry,
  RunCapability,
  RunCapabilityContext,
} from "@clarvis/capability";
import { createCapabilityRequestView, createCapabilityServices } from "@clarvis/capability";
import { TOOL_EFFECT_PORT } from "@clarvis/capability";
import { orderCapabilities } from "./capability-order.ts";
import { collectCapabilityToolMetadata } from "./capability-tool-metadata.ts";
import { createToolEffectPort } from "./tools/tool-effect.ts";
import { createEntryInput } from "./entry-inputs.ts";
import { buildElicitRelay } from "./elicit-relay.ts";
import { openToolPool } from "./open-tool-pool.ts";
import { deriveRunShape, resolveConfig, type RunShape } from "./run-shape.ts";
import { loopResultToResponse } from "./run-response-mapping.ts";
import {
  createRunTraceProjectors,
  deriveInitDetail,
  deriveRunEndedDetail,
  deriveRunStartedDetail,
  traceBridge,
} from "./run-trace.ts";
import { runWithClockAndTimeout } from "./run-timeout.ts";
import { runVisionPrepass } from "./vision-prepass.ts";
import { boundPromise } from "./support/bounded.ts";
import type { ExtensionAdmissionController } from "@clarvis/capability";
import {
  admittedRunCapability,
  capabilityActivationOperation,
  extensionAdmissionFor,
  isExtensionAdmissionRefusal,
} from "./extension-admission.ts";

/**
 * The inputs {@link runOrchestrator} needs to drive one run: providers and pool,
 * the workspace/owner scoping, optional cancellation/elicit/steer channels, an
 * optional `continuation` to resume from, and the registered capabilities.
 *
 * @remarks A trimmed slice of {@link ExecuteRunDeps} plus the per-run channels;
 *   `executeRun` builds this and hands the orchestrator the promptcache-keyed LLM.
 */
export interface OrchestratorDeps {
  env: EnvConfig;
  llm: LLMProvider;
  connections: ConnectionManager;
  logger?: Logger;
  onEvent?: (event: TraceEvent) => void;
  resultContract?: ResultContract;
  signal?: AbortSignal;
  elicit?: Elicit;
  steer?: SteerSource;
  compaction?: CompactionSource;
  continuation?: RunContinuation;
  workspaceRoot: string;
  executionId?: string;
  /** The run's owner key, for capability activation and per-owner scoping. */
  owner: string;
  /** Registered capabilities; the orchestrator applies each per-run gate
   * (forRun) and threads the resulting activations through the run. */
  capabilities?: readonly Capability[];
  /** The exact request view already used for preflight by `executeRun`. */
  requestView?: CapabilityRequestView;
  /** Full validated grant catalogue, including host-registered declarations. */
  grantDeclarations?: readonly CapabilityGrantDeclaration[];
  /** Immutable projector snapshot shared by live, journal, and persisted mapping. */
  persistedTraceProjectors?: PersistedTraceProjectorRegistry;
  /** Host listener for capability events; throws must already be swallowed. */
  emitCapabilityEvent?: CapabilityEventListener;
  /** Host-owned physical gate for capability and lifecycle extension code. */
  extensionAdmission?: ExtensionAdmissionController;
  /**
   * Opens the run's crash-recovery journal, given the wall-clock start.
   *
   * @remarks A factory rather than a journal because the run's start time - which
   *   names the file and stamps the header - is only known here. The caller owns
   *   the returned journal's lifetime; see {@link OrchestratorResult.journal}.
   */
  openJournal?: (wallStartedAt: number) => RunJournal | undefined;
}

export type { RunContinuation };

/**
 * The registration names of the three built-in capabilities, for `run.composed`.
 *
 * @remarks Duplicated as literals rather than imported, because the two owners
 *   that could export them — `@clarvis/loop/capabilities/tools` and
 *   `@clarvis/skills/capability` — are both optional-package-reaching modules,
 *   and this file is on the engine's eager path. That is the same
 *   duplicate-plus-drift-test arrangement used for `DEFAULT_PENDING_TASK_NUDGES`;
 *   the lock is
 *   `tests/architecture/builtin-capability-names.test.ts`. `hooks` needs no
 *   duplicate: its name lives in `@clarvis/capability`, which is never optional.
 */
export const BUILTIN_CAPABILITY_NAMES = {
  tools: "tools",
  skills: "skills",
  hooks: HOOKS_CAPABILITY_NAME,
} as const;

/**
 * What {@link runOrchestrator} returns to {@link executeRun}: the run's
 * {@link RunResponse}, the sealed in-memory `trace`, the wall-clock start, and the
 * artifacts the caller persists or acts on after the run — the restorable
 * `finalContext` and the activated `runCapabilities`.
 */
export interface OrchestratorResult {
  response: RunResponse;
  trace: RecordingTrace;
  wallStartedAt: number;
  finalContext?: ContextSnapshotEntry[];
  /** The run's activated capabilities, so the caller can fire post-persist
   * observers (onRunEnd) once the execution record exists. */
  runCapabilities: RunCapability[];
}

/** The entry agent's contribution to {@link OrchestratorResult}: its response plus
 * the captured `finalContext` sink. */
interface EntryAgentOutcome {
  response: RunResponse;
  finalContext?: ContextSnapshotEntry[];
}

export type { ClockHolder };

/**
 * Set up and run a single agent run: activate capabilities, build the trace and
 * seed, open the MCP tool pool, then run the entry agent (lead or subagent) under
 * a clock and timeout, always releasing pooled connections.
 *
 * @param request - the validated run request.
 * @param deps - providers, scoping, channels and capabilities; see
 *   {@link OrchestratorDeps}.
 * @returns the {@link OrchestratorResult} with a sealed trace, ready to persist.
 * @remarks Runs each capability's `forRun` gate to produce the run's
 *   {@link RunCapability | activations}, collects their lifecycle hooks and seed
 *   blocks, records `init`/`run_started`, fires `onRunStart`/`onRunEnd` observers,
 *   and — in `lead-subagent` vs `subagent-only` mode — either short-circuits with
 *   the pool's failure response or runs the entry agent to completion. The elicit
 *   channel is wait-bounded and serialized before it reaches the run.
 *
 */
export async function runOrchestrator(
  request: RunRequest,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  const config = resolveConfig(request, deps.env);
  const profileRegistry = resolveSubagentProfiles(request.profiles, request.providers, deps.env);
  const allCapabilities = deps.capabilities ?? [];
  const capabilityToolMetadata = collectCapabilityToolMetadata(allCapabilities);
  const persistedTraceProjectors =
    deps.persistedTraceProjectors ?? createRunTraceProjectors(allCapabilities);
  const requestView = deps.requestView ?? createCapabilityRequestView(request);
  const shape = deriveRunShape(
    request,
    profileRegistry,
    allCapabilities.some((capability) => capability.requiresUserInput?.(requestView) === true),
  );

  const clockHolder: ClockHolder = {};
  const grantDeclarations =
    deps.grantDeclarations ?? allCapabilities.flatMap((capability) => capability.grants ?? []);
  const agents = canSpawnChildren(shape, grantDeclarations)
    ? createAgentRegistry({
        limits: resolveAgentsLimits(request, deps.env),
        ...(deps.logger !== undefined
          ? { logger: bind(deps.logger, { component: "agents" }) }
          : {}),
        onActivity: () => clockHolder.clock?.poke(),
      })
    : undefined;

  const services = createCapabilityServices();
  if (agents !== undefined) services.provide(AGENT_REGISTRY_PORT, agents);
  const capabilityCtx: RunCapabilityContext = {
    owner: deps.owner,
    services,
    executionId: deps.executionId ?? request.execution_id ?? "run",
    ...(deps.continuation?.capability_state !== undefined
      ? { priorState: deps.continuation.capability_state }
      : {}),
    ...requestView,
    entryGrants: shape.entryProfile.grants ?? [],
    env: deps.env,
    workspaceRoot: deps.workspaceRoot,
    llm: deps.llm,
    ...(deps.elicit !== undefined ? { elicit: deps.elicit } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    emit: deps.emitCapabilityEvent ?? ((): void => {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
  const setupTimeoutMs = deps.env.CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS;
  const extensionAdmission = extensionAdmissionFor(deps);
  const runCapabilities: RunCapability[] = orderCapabilities(
    (
      await Promise.all(
        allCapabilities.map(async (capability) => {
          let timedOut = false;
          // Always invoke the activation, even for a pre-aborted run. The
          // activation owns finalizeRun/onRunEnd, which must still observe the
          // cancelled record. Cooperative setup sees the aborted ctx.signal;
          // the independent wall bound prevents an uncooperative extension
          // from holding cancellation forever.
          let activated: RunCapability | null;
          const activationStart = performance.now();
          try {
            activated = await boundPromise(
              () =>
                extensionAdmission.call(
                  capabilityActivationOperation(capability.name),
                  deps.signal?.aborted === true ? "run_end" : "normal",
                  () => capability.forRun(capabilityCtx),
                ),
              {
                timeoutMs: setupTimeoutMs,
                onTimeout: () => {
                  timedOut = true;
                  return null;
                },
                onAbort: () => null,
              },
            );
          } catch (error) {
            if (!isExtensionAdmissionRefusal(error)) throw error;
            deps.logger?.warn(
              {
                event: "capability.extension_saturated",
                capability: capability.name,
                operation: error.operation,
                reason: error.reason,
              },
              "the host's extension gate is saturated; forRun is skipped before invocation",
            );
            return null;
          }
          if (timedOut) {
            deps.logger?.warn(
              {
                event: "capability.setup_timeout",
                capability: capability.name,
                phase: "for_run",
                timeout_ms: setupTimeoutMs,
              },
              "forRun exceeded its wall budget; the capability contributes nothing this run",
            );
          }
          if (activated === null) return null;
          if (deps.logger !== undefined && levelEnabled(deps.logger, "debug")) {
            deps.logger.debug(
              {
                event: "capability.activated",
                capability: capability.name,
                duration_ms: Math.round(performance.now() - activationStart),
                tools: capability.reservedWireNames?.length ?? 0,
                has_seed_block: activated.seedBlock !== undefined,
              },
              "a capability activated for this run and contributed its share of the agent's surface",
            );
          }
          return admittedRunCapability(capability.name, activated, extensionAdmission, deps.logger);
        }),
      )
    ).filter((capability): capability is RunCapability => capability !== null),
  );
  const hooks: LifecycleHook[] = runCapabilities.flatMap((c) => c.lifecycle ?? []);
  const seedBlocks = (
    await Promise.all(
      runCapabilities.map(async (capability) => {
        if (capability.seedBlock === undefined) return undefined;
        let timedOut = false;
        const block = await boundPromise(() => Promise.resolve(capability.seedBlock?.()), {
          timeoutMs: setupTimeoutMs,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          onTimeout: () => {
            timedOut = true;
            return undefined;
          },
          onAbort: () => undefined,
        });
        if (timedOut) {
          deps.logger?.warn(
            {
              event: "capability.setup_timeout",
              capability: capability.name,
              phase: "seed_block",
              timeout_ms: setupTimeoutMs,
            },
            "seedBlock exceeded its wall budget; the block is omitted from the seed",
          );
        }
        return block;
      }),
    )
  ).filter((block): block is string => block !== undefined);
  const seedMarkers = allCapabilities
    .map((c) => c.seedMarker)
    .filter((m): m is string => m !== undefined);
  services.provide(TOOL_EFFECT_PORT, createToolEffectPort(capabilityToolMetadata.toolEffects));

  const { provider } = parseModelRef(shape.entryProfile.model);
  const journal = deps.openJournal?.(wallStartedAt);
  const traceHandle = createTrace(
    startedAt,
    traceBridge({
      clockHolder,
      wallStartedAt,
      projectors: persistedTraceProjectors,
      ...(deps.onEvent !== undefined ? { emitEvent: deps.onEvent } : {}),
      ...(agents !== undefined
        ? {
            ingest: (entry: TraceEntry): void => {
              agents.ingestTraceEntry(entry);
            },
          }
        : {}),
      ...(journal !== undefined
        ? {
            journal: (event: TraceEvent): void => {
              journal.append(event);
            },
          }
        : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    }),
  );
  const mode = shape.isLead ? "lead-subagent" : "subagent-only";
  reportRunComposition(deps.logger, {
    request,
    shape,
    mode,
    runCapabilities,
    seedBlockCount: seedBlocks.length,
  });
  traceHandle.record("init", deriveInitDetail(config, provider, mode));
  traceHandle.record("run_started", deriveRunStartedDetail(shape, config, mode));
  await fireObservers(
    hooks,
    "onRunStart",
    {
      mode,
      entry: request.entry,
      ...(shape.isLead ? { leadModel: shape.entryProfile.model } : {}),
      ...(shape.primarySubagentModel !== undefined
        ? { subagentModel: shape.primarySubagentModel }
        : {}),
    },
    deps.logger,
    {
      timeoutMs: setupTimeoutMs,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
  );

  const wrap = async (
    response: RunResponse,
    extras?: Pick<EntryAgentOutcome, "finalContext">,
  ): Promise<OrchestratorResult> => {
    const guardTripCodes = new Set(runCapabilities.flatMap((c) => c.guardTripCodes ?? []));
    traceHandle.record("run_ended", deriveRunEndedDetail(response, guardTripCodes));
    await fireObservers(
      hooks,
      "onRunEnd",
      {
        status: response.status,
        ...(response.status === "error" ? { errorCode: response.error.code } : {}),
        iterationsUsed: response.usage.iterations_used,
        elapsedMs: response.usage.elapsed_ms,
      },
      deps.logger,
      {
        timeoutMs: deps.env.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS,
      },
    );
    traceHandle.seal();
    return {
      response,
      trace: traceHandle.trace,
      wallStartedAt,
      ...(extras?.finalContext !== undefined ? { finalContext: extras.finalContext } : {}),
      runCapabilities,
    };
  };

  const emptyUsage = (): Usage => ({
    iterations_used: 0,
    elapsed_ms: Math.round(performance.now() - startedAt),
    by_agent: [],
  });

  const elicitWaitMs = request.elicit_wait_ms ?? deps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS;
  const boundedDeps: OrchestratorDeps =
    deps.elicit !== undefined ? { ...deps, elicit: withElicitWaitBound(deps.elicit) } : deps;
  const { serializedElicit, relay } = buildElicitRelay({
    ...(boundedDeps.elicit !== undefined ? { elicit: boundedDeps.elicit } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    clockHolder,
    trace: traceHandle,
    enabled: shape.userInputEnabled,
    elicitWaitMs,
  });
  const depsForMode: OrchestratorDeps = {
    ...boundedDeps,
    elicit: serializedElicit,
  };

  const poolResult = await openToolPool({
    request,
    connections: deps.connections,
    owner: deps.owner,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    relay,
    emptyUsage,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  if (!poolResult.ok) return await wrap(poolResult.response);
  const opened = poolResult.opened;
  if (poolResult.degraded.length > 0) {
    traceHandle.record("mcp_degraded", { servers: poolResult.degraded });
  }

  try {
    const outcome = await runEntryAgent({
      request,
      deps: depsForMode,
      startedAt,
      traceHandle,
      config,
      shape,
      opened,
      clockHolder,
      runCapabilities,
      seedBlocks,
      seedMarkers,
      capabilityReserved: capabilityToolMetadata.reservedWireNames,
      hooks,
      services,
    });
    return await wrap(outcome.response, outcome);
  } finally {
    await Promise.allSettled(opened.map((o) => o.release()));
  }
}

/**
 * State one line of what this run was actually assembled from.
 *
 * @param logger - the run-scoped logger, or `undefined` when the host wired none.
 * @param p - the composed run: the request, its derived shape and mode, the
 *   activated capabilities and how many contributed a seed block.
 * @remarks `info`, and once per run. Every other question about a run has an
 *   answer somewhere — the trace says what the agent did, the settings say what
 *   was configured — but "which capabilities were actually live, over which
 *   tools, against which model" was reconstructible from nothing. Three separate
 *   defects (`dcc6289`, `9f047d9`, and the ordering rule in
 *   `specs/engine/capability-composition.md`) were all the same missing line.
 *
 *   `capabilities` is in **activation order**, which is dispatch order: a
 *   capability's handlers shadow every later one's, so the order is the answer
 *   to "why did this tool call reach that handler" and not decoration.
 */
function reportRunComposition(
  logger: Logger | undefined,
  p: {
    request: RunRequest;
    shape: RunShape;
    mode: string;
    runCapabilities: readonly RunCapability[];
    seedBlockCount: number;
  },
): void {
  if (logger === undefined || !levelEnabled(logger, "info")) return;
  const names = new Set(p.runCapabilities.map((capability) => capability.name));
  logger.info(
    {
      event: "run.composed",
      capabilities: p.runCapabilities.map((capability) => capability.name),
      builtins: {
        tools: names.has(BUILTIN_CAPABILITY_NAMES.tools),
        skills: names.has(BUILTIN_CAPABILITY_NAMES.skills),
        hooks: names.has(BUILTIN_CAPABILITY_NAMES.hooks),
      },
      tools: p.shape.entryResolved.tools,
      mcp_servers: p.request.servers.map((server) => server.name),
      entry_agent: p.request.entry,
      model: p.shape.entryProfile.model,
      mode: p.mode,
      seed_blocks: p.seedBlockCount,
    },
    "the run is composed and about to start",
  );
}

/** The fully-prepared context {@link runEntryAgent} runs from: the request, the
 * opened tool pool, the derived shape/config, and the run's capabilities, hooks and
 * seed material. */
interface RunEntryParams {
  request: RunRequest;
  deps: OrchestratorDeps;
  startedAt: number;
  traceHandle: TraceHandle;
  config: ResolvedConfig;
  shape: RunShape;
  opened: OpenedConnection[];
  clockHolder: ClockHolder;
  runCapabilities: readonly RunCapability[];
  seedBlocks: readonly string[];
  seedMarkers: readonly string[];
  /** Wire names the run's registered capabilities own, reserved against MCP. */
  capabilityReserved: readonly string[];
  hooks: LifecycleHook[];
  /** The run's inter-capability port registry. */
  services: CapabilityServices;
}

/**
 * Build and run the entry agent's loop, wiring its tool registry, token ledger,
 * iteration cap, usage accounting, seed and input builder, then executing it under
 * a clock and timeout (after a vision prepass).
 *
 * @param p - the prepared run context; see {@link RunEntryParams}.
 * @returns the entry agent's {@link EntryAgentOutcome} — response plus captured
 *   final context.
 * @remarks The entry iteration cap differs by role: a soft-mode lead mirrors the
 *   configured limit as its soft cap, a hard lead runs uncapped
 *   (`POSITIVE_INFINITY`), and a subagent uses {@link resolveIterationCap}. The
 *   empty-result fallback message is role-aware (lead vs subagent vs generic).
 */
async function runEntryAgent(p: RunEntryParams): Promise<EntryAgentOutcome> {
  const { request, startedAt, traceHandle, config, shape, opened } = p;
  const { entryResolved, isLead } = shape;
  const deps = {
    ...p.deps,
    runCapabilities: p.runCapabilities,
    seedBlocks: p.seedBlocks,
    seedMarkers: p.seedMarkers,
    capabilityReserved: p.capabilityReserved,
    ...(p.hooks.length > 0 ? { hooks: p.hooks } : {}),
    services: p.services,
  };

  let readFinalContext: (() => ContextSnapshotEntry[]) | undefined;

  const registry = buildRegistry(selectTools(opened, entryResolved.tools), p.capabilityReserved);
  const ledger = createTokenLedger(config.max_tokens);
  const entryMax = isLead
    ? shape.softMode
      ? (entryResolved.iterationLimit ?? deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT)
      : (entryResolved.iterationLimit ?? Number.POSITIVE_INFINITY)
    : resolveIterationCap(entryResolved, deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT);
  const semaphore = createSemaphore(deps.env.CLARVIS_MAX_PARALLEL_SUBAGENTS);

  const accounting = createUsageAccounting({ shape, deps, entryMax, startedAt });
  const { counter, entryUsage, subagentAggByModel } = accounting;

  const seed = buildEntrySeed({ messages: request.messages, deps, shape });
  const { entryMessages, turnImages } = seed;

  const buildEntryInput = createEntryInput({
    request,
    deps,
    shape,
    trace: traceHandle,
    registry,
    opened,
    ledger,
    counter,
    entryUsage,
    entryMax,
    entryMessages,
    turnImages,
    ...(semaphore !== undefined ? { semaphore } : {}),
    subagentAggByModel,
    warnings: accounting.warnings,
    onContext: (ctx) => {
      readFinalContext = () => ctx.snapshot();
    },
  });

  const response = await runWithClockAndTimeout({
    config,
    settleGraceMs: deps.env.CLARVIS_RUN_ABORT_SETTLE_MS,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.signal !== undefined ? { externalSignal: deps.signal } : {}),
    startedAt,
    clockHolder: p.clockHolder,
    finalize: accounting.finalize,
    buildLoop: async ({ clock, signal }) => {
      await runVisionPrepass({
        signal,
        deps,
        request,
        trace: traceHandle,
        ledger,
        seed,
        accounting,
      });
      return runAgent(buildEntryInput(clock, signal));
    },
    toResponse: (loopResult, usage) =>
      loopResultToResponse(loopResult, usage, (code) =>
        isLead
          ? "Lead returned an empty response."
          : code === "empty_response"
            ? "LLM returned an empty response."
            : "Run terminated with no result.",
      ),
  });

  const finalContext = readFinalContext?.();
  return {
    response,
    ...(finalContext !== undefined && finalContext.length > 0 ? { finalContext } : {}),
  };
}
