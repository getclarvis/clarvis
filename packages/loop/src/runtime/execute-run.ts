import { composePromptCacheKey, sanitizeErrorMessage, contentToText } from "@clarvis/capability";
import { randomUUID } from "node:crypto";
import type { EnvConfig } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import { withPromptCacheDefaults } from "@clarvis/llm";
import type { ConnectionManager } from "@clarvis/mcp-client";
import type { Logger } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import type { RunJournal } from "@clarvis/trace";
import type { RunResponse } from "@clarvis/capability";
import type { CompactionSource, SteerSource } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import { bind, unref } from "@clarvis/capability";
import { deriveRunShape, validateBody } from "../validation/request-schema.ts";
import { runOrchestrator } from "./orchestrator.ts";
import type { RunContinuation } from "@clarvis/capability";
import { compileResultContract } from "./tools/result-contract.ts";
import { generateExecutionId } from "@clarvis/trace";
import { mapTrace } from "@clarvis/trace";
import { buildRecord } from "@clarvis/trace";
import {
  ConflictError,
  ContinuationUnavailableError,
  PersistenceError,
  ValidationError,
  executionIdConflict,
} from "@clarvis/capability";
import type { Elicit } from "./tools/ask-user-tool.ts";
import type {
  Capability,
  CapabilityEvent,
  CapabilityRegistry,
  CapabilityRequestView,
  PersistedTraceProjectorRegistry,
  CapabilityEventListener,
  ExecutionStatus,
  RunCapability,
} from "@clarvis/capability";
import { composeCapabilityRegistry, createCapabilityRequestView } from "@clarvis/capability";
import { createRunTraceProjectors } from "./run-trace.ts";
import { boundPromise } from "./support/bounded.ts";
import type { ExtensionAdmissionController } from "@clarvis/capability";
import type {
  OperatorAuthorityReader,
  OperatorAuthoritySeed,
  OperatorAuthorityState,
  UserSteerContext,
} from "@clarvis/capability";
import { extensionAdmissionFor } from "./extension-admission.ts";

/**
 * The long-lived collaborators an {@link executeRun} call needs: the environment
 * config, LLM provider, MCP connection pool, trace persistence, the workspace
 * root, and the capabilities built once alongside them.
 *
 * @remarks Constructed once (typically by {@link buildExecuteRunDeps}) and reused
 *   across runs; per-run inputs (the request body, signals, elicit channel) arrive
 *   through {@link ExecuteRunArgs} instead.
 */
export interface ExecuteRunDeps {
  /** Host substrate factory; callbacks are private to the engine, never capability ports. */
  operatorAuthority?: (input: {
    seed?: OperatorAuthoritySeed;
    prior?: OperatorAuthorityState;
    parent?: OperatorAuthorityReader;
    owner: string;
    executionId: string;
    signal?: AbortSignal;
  }) => {
    reader: OperatorAuthorityReader;
    onSteer(context: UserSteerContext): void;
    finalize(outcome: {
      status: string;
      disposition?: "final" | "checkpoint";
    }): OperatorAuthorityState;
  };
  env: EnvConfig;
  llm: LLMProvider;
  connections: ConnectionManager;
  traceStore: TraceStore;
  logger?: Logger;
  workspaceRoot: string;
  /** Long-lived capabilities, built once with the deps (tools, ask-user,
   * skills, plus anything the host registers). */
  capabilities?: Capability[];
  /**
   * The settings/request-param specs those capabilities registered.
   *
   * @remarks Without it a run request carrying a capability's own per-run param
   * is rejected by the request schema's `strict()`, since the engine declares
   * only its own fields.
   */
  capabilityRegistry?: CapabilityRegistry;
  /** Optional immutable host projector registry extended per run. */
  persistedTraceProjectors?: PersistedTraceProjectorRegistry;
  /** Host-owned gate whose permits follow physical extension promises. */
  extensionAdmission?: ExtensionAdmissionController;
  /** Host metadata captured once per run and persisted without engine interpretation. */
  hostMetadata?: () => Record<string, unknown> | undefined;
}

/**
 * Everything one run needs beyond the shared {@link ExecuteRunDeps}: the raw
 * request `rawBody`, the `owner` key it is scoped and persisted under, and the
 * optional per-run channels (events, cancellation, elicitation, steering, extra
 * capabilities).
 */
export interface ExecuteRunArgs {
  /** Authenticated host input; intentionally absent from rawBody and RunRequest. */
  operatorAuthoritySeed?: OperatorAuthoritySeed;
  /** Same-process inherited authority is fenced against the parent's live revision. */
  operatorAuthorityParent?: OperatorAuthorityReader;
  /** Host controller retirement revokes intention without cancelling background execution. */
  operatorAuthoritySignal?: AbortSignal;
  rawBody: unknown;
  owner: string;
  deps: ExecuteRunDeps;
  onEvent?: (event: TraceEvent) => void;
  externalSignal?: AbortSignal;
  elicit?: Elicit;
  steer?: SteerSource;
  /** Explicit entry-agent compaction requests, drained before iterations. */
  compaction?: CompactionSource;
  /** Per-run capabilities from session-bound hosts (e.g. lifecycle hooks);
   * activated after the deps-level ones. */
  capabilities?: Capability[];
  /** Observes capability progress (a capability's own out-of-band notices,
   * which fire after the run's response has already been returned). */
  onCapabilityEvent?: CapabilityEventListener;
}

/**
 * The result of a completed {@link executeRun}: the `executionId` the trace was
 * persisted under and the run's {@link RunResponse}.
 */
export interface ExecuteRunOutcome {
  executionId: string;
  response: RunResponse;
}

/** Whether `err` is the execution-id-already-taken {@link ConflictError}. */
function isExecutionIdConflict(err: unknown): boolean {
  return err instanceof ConflictError;
}

/**
 * Per-{@link TraceStore} registry of execution ids currently running, keyed by
 * owner, used by {@link reserveExecutionId} to reject a concurrent duplicate id
 * before its trace has been persisted.
 */
const inFlightIds = new WeakMap<TraceStore, Map<string, Set<string>>>();
/**
 * Claim `executionId` for `owner` for the duration of a run, guarding against two
 * in-flight runs sharing an id (the persisted-trace uniqueness check cannot yet
 * see an id whose trace has not been written).
 *
 * @returns a release function that frees the id (call it in a `finally`).
 * @throws the execution-id-conflict {@link ConflictError} if the id is already in
 *   flight for this owner.
 */
function reserveExecutionId(store: TraceStore, owner: string, executionId: string): () => void {
  let byOwner = inFlightIds.get(store);
  if (byOwner === undefined) {
    byOwner = new Map();
    inFlightIds.set(store, byOwner);
  }
  let ids = byOwner.get(owner);
  if (ids === undefined) {
    ids = new Set();
    byOwner.set(owner, ids);
  }
  if (ids.has(executionId)) throw executionIdConflict(executionId);
  ids.add(executionId);
  return () => {
    ids.delete(executionId);
    if (ids.size === 0) byOwner.delete(owner);
  };
}

/**
 * Await `work`, giving up after `budgetMs`.
 *
 * @param work - the promise to wait on.
 * @param budgetMs - how long the response may be held.
 * @param onTimeout - called when the budget elapses first.
 * @returns once `work` settles or the budget elapses, whichever comes first.
 * @remarks The timer is unref'd, so a pending budget can never be the reason a
 * process stays alive. Work that outlives the budget is not cancelled — it
 * simply stops being waited on.
 */
async function raceWithBudget(
  work: Promise<unknown>,
  budgetMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
    unref(timer);
  });
  try {
    if ((await Promise.race([work.then(() => "done" as const), budget])) === "timeout") onTimeout();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Collect every capability's durable state for the run's record.
 *
 * @param capabilities - the run's activated capabilities, in registration order.
 * @param outcome - the run's terminal status and accepted finalization disposition.
 * @param prior - the continued run's state, carried forward for any capability
 *   that did not run this time.
 * @param logger - warns on a `finalizeRun` that throws.
 * @returns the state map keyed by capability name, or `undefined` when no
 *   capability contributed anything (so the record stays free of an empty
 *   object).
 * @remarks A capability that throws here forfeits its slot and nothing more: the
 *   run has already produced its answer, and losing a feature's bookkeeping must
 *   never lose the user's work. Carrying `prior` forward is what makes a
 *   continuation whose second turn did not activate a capability keep the first
 *   turn's state instead of silently dropping it.
 */
export async function collectCapabilityState(
  capabilities: readonly RunCapability[],
  outcome: { status: ExecutionStatus; disposition?: "final" | "checkpoint" },
  prior: Record<string, unknown> | undefined,
  logger?: Logger,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | undefined> {
  const state: Record<string, unknown> = { ...(prior ?? {}) };
  const preserveState =
    outcome.disposition === "checkpoint" ||
    (outcome.status !== "completed" &&
      capabilities.some((capability) => capability.preserveStateOnInterruption === true));
  const finalized = await Promise.all(
    capabilities.map(async (capability) => {
      if (capability.finalizeRun === undefined) return { capability, value: undefined };
      let timedOut = false;
      try {
        const value = await boundPromise(
          () =>
            Promise.resolve(
              capability.finalizeRun?.({
                status: outcome.status,
                ...(outcome.disposition === undefined ? {} : { disposition: outcome.disposition }),
                preserveState,
              }),
            ),
          {
            timeoutMs,
            onTimeout: () => {
              timedOut = true;
              return undefined;
            },
            onAbort: () => undefined,
          },
        );
        if (timedOut) {
          logger?.warn(
            {
              event: "capability.finalize_timeout",
              capability: capability.name,
              timeout_ms: timeoutMs,
            },
            "finalizeRun exceeded its wall budget; the capability's state slot is omitted",
          );
        }
        return { capability, value };
      } catch (err) {
        logger?.warn(
          {
            event: "capability.finalize_failed",
            capability: capability.name,
            cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "finalizeRun threw; the capability's state slot is omitted",
        );
        return { capability, value: undefined };
      }
    }),
  );
  for (const { capability, value } of finalized) {
    if (value !== undefined) state[capability.name] = value;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Validate, run, and persist one agent run end-to-end: the outermost entry point
 * that turns a raw request body into a persisted trace and a {@link RunResponse}.
 *
 * @param args - the run's inputs; see {@link ExecuteRunArgs}.
 * @returns the {@link ExecuteRunOutcome} (execution id + response) once the trace
 *   has been persisted.
 * @throws {@link ValidationError} if the body is invalid, or a soft budget /
 *   `ask_user` grant, or a capability needing a human, is requested without an `elicit` channel.
 * @throws the execution-id-conflict {@link ConflictError} if the requested or
 *   reserved `execution_id` is already taken (existing trace or in-flight run).
 * @throws {@link ContinuationUnavailableError} if `continue_from` names a run with
 *   no restorable final context.
 * @throws {@link PersistenceError} if the run completed but its trace could not be
 *   written.
 * @remarks Orchestrates the run under a reserved id, then collects each
 *   capability's durable state, builds and inserts the record, and fires
 *   each capability's `onRunEnd` — including for a cancelled run, since a
 *   stopped attempt often carries the most useful lesson and its record is
 *   persisted either way. Any promise an `onRunEnd` returns is awaited under
 *   {@link EnvConfig.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS} so a capability can
 *   make its durable intent survive before the response returns, without
 *   blocking on the rest. An `externalSignal` abort is forwarded to the run's
 *   own controller. A capability's own lifecycle events surface to the host through
 *   {@link CapabilityEvent}s on {@link ExecuteRunArgs.onCapabilityEvent}.
 */
export async function executeRun({
  operatorAuthoritySeed,
  operatorAuthorityParent,
  operatorAuthoritySignal,
  rawBody,
  owner,
  deps,
  onEvent,
  externalSignal,
  elicit,
  steer,
  compaction,
  capabilities,
  onCapabilityEvent,
}: ExecuteRunArgs): Promise<ExecuteRunOutcome> {
  const extensionAdmission = extensionAdmissionFor(deps);
  const allCapabilities = [...(deps.capabilities ?? []), ...(capabilities ?? [])];
  const persistedTraceProjectors = createRunTraceProjectors(
    allCapabilities,
    deps.persistedTraceProjectors,
  );
  const requestRegistry = composeCapabilityRegistry(
    deps.capabilityRegistry,
    allCapabilities.flatMap((capability) => capability.grants ?? []),
  );
  const { request: parsed } = validateBody(rawBody, deps.env, requestRegistry);
  const requestView: CapabilityRequestView = createCapabilityRequestView(parsed);
  const hostMetadata = deps.hostMetadata?.();
  const capabilityNeedsHuman = allCapabilities.some(
    (capability) => capability.requiresUserInput?.(requestView) === true,
  );
  const shape = deriveRunShape(parsed, capabilityNeedsHuman)!;
  const runMode = shape.isLead ? "lead-subagent" : "subagent-only";
  if (shape.userInputEnabled && elicit === undefined) {
    throw new ValidationError(
      "elicitation_not_supported",
      "an 'ask_user' grant, a soft budget, or a capability that must reach the human " +
        "requires an MCP client that declares the 'elicitation' capability.",
      { capability: "elicitation" },
    );
  }

  const resultContract =
    parsed.output_schema !== undefined ? compileResultContract(parsed.output_schema) : undefined;

  let executionId: string;
  if (parsed.execution_id !== undefined) {
    executionId = parsed.execution_id;
    if (deps.traceStore.existsForOwner(owner, executionId)) {
      throw executionIdConflict(executionId);
    }
  } else {
    executionId = generateExecutionId();
  }

  /**
   * The run-scoped logger every collaborator below this line receives.
   *
   * @remarks The run scope of the four correlation scopes named in
   *   `specs/cross-cutting/observability.md` §4.1. It is bound here because this is where the
   *   execution ID is minted, and it is `undefined` when the host wired no
   *   logger so that "no logger" keeps meaning silence rather than a no-op
   *   object every downstream presence check would now accept. `bind` degrades
   *   to the logger itself when the backing sink implements no `child`, so a
   *   plain four-method host sink still works — it simply loses the correlation.
   */
  const runLogger: Logger | undefined =
    deps.logger === undefined
      ? undefined
      : bind(deps.logger, { execution_id: executionId, owner_key_name: owner, mode: runMode });

  const releaseExecutionId = reserveExecutionId(deps.traceStore, owner, executionId);
  try {
    const promptCacheTtl = parsed.prompt_cache_ttl ?? (shape.humanParkLikely ? "1h" : "5m");

    let continuation: RunContinuation | undefined;
    let priorAuthority: OperatorAuthorityState | undefined;
    if (parsed.continue_from !== undefined) {
      const prior = deps.traceStore.getById(owner, parsed.continue_from);
      if (prior === null || prior.final_context === undefined || prior.final_context.length === 0) {
        throw new ContinuationUnavailableError(parsed.continue_from);
      }
      continuation = {
        context: prior.final_context,
        ...(prior.capability_state === undefined
          ? {}
          : { capability_state: prior.capability_state }),
      };
      priorAuthority = prior.operator_authority_state;
      parsed.session_id ??= prior.request.session_id ?? prior.id;
      parsed.agent_instance_id ??= prior.request.agent_instance_id;
    }
    parsed.session_id ??= executionId;
    parsed.agent_instance_id ??= randomUUID();
    const identity = { sessionId: parsed.session_id, agentInstanceId: parsed.agent_instance_id };
    try {
      composePromptCacheKey(identity);
    } catch {
      throw new ValidationError(
        "invalid_prompt_cache_key",
        "Invalid session/agent prompt-cache identity or composed key exceeds 512 characters",
      );
    }

    const emit: CapabilityEventListener = (event: CapabilityEvent): void => {
      try {
        onCapabilityEvent?.(event);
      } catch {
        // A listener throw must never affect the run or the emitting capability.
      }
    };

    const controller = new AbortController();
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(externalSignal?.reason ?? { source: "mcp" });
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let journal: RunJournal | undefined;
    const authority = deps.operatorAuthority?.({
      seed: operatorAuthoritySeed,
      parent: operatorAuthorityParent,
      prior: priorAuthority,
      owner,
      executionId,
      signal:
        operatorAuthoritySignal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, operatorAuthoritySignal]),
    });
    const admittedSteers = new Map<string, string>();
    const authoritySteer: SteerSource | undefined =
      steer === undefined
        ? undefined
        : {
            drain() {
              return steer.drain().map((message) => {
                const id = message.id ?? randomUUID();
                if (
                  operatorAuthoritySeed !== undefined &&
                  operatorAuthoritySeed.parent_run_id === undefined
                ) {
                  admittedSteers.set(id, contentToText(message.content));
                }
                return { ...message, id };
              });
            },
          };
    try {
      const { response, trace, wallStartedAt, finalContext, runCapabilities } =
        await runOrchestrator(parsed, {
          operatorAuthority: authority?.reader,
          onOperatorSteer:
            authority === undefined
              ? undefined
              : (context) => {
                  if (
                    context.id === undefined ||
                    admittedSteers.get(context.id) !== context.message
                  )
                    return;
                  admittedSteers.delete(context.id);
                  authority.onSteer(context);
                },
          openJournal: (startedAt: number): RunJournal | undefined => {
            journal = deps.traceStore.openJournal?.({
              header: {
                id: executionId,
                owner_key_name: owner,
                started_at: startedAt,
                request: parsed,
                ...(hostMetadata === undefined ? {} : { host_metadata: hostMetadata }),
              },
              ...(runLogger !== undefined ? { logger: runLogger } : {}),
            });
            return journal;
          },
          env: deps.env,
          llm: withPromptCacheDefaults(deps.llm, { identity, promptCacheTtl }),
          connections: deps.connections,
          logger: runLogger,
          onEvent,
          resultContract,
          signal: controller.signal,
          elicit,
          ...(authoritySteer !== undefined ? { steer: authoritySteer } : {}),
          ...(compaction !== undefined ? { compaction } : {}),
          ...(continuation !== undefined ? { continuation } : {}),
          workspaceRoot: deps.workspaceRoot,
          executionId,
          owner,
          capabilities: allCapabilities,
          requestView,
          grantDeclarations: requestRegistry.grants(),
          persistedTraceProjectors,
          emitCapabilityEvent: emit,
          extensionAdmission,
        });

      const capabilityState = await collectCapabilityState(
        runCapabilities,
        response,
        continuation?.capability_state,
        runLogger,
        deps.env.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS,
      );
      const record = buildRecord({
        id: executionId,
        owner,
        request: parsed,
        response,
        trace: mapTrace(trace.entries, wallStartedAt, persistedTraceProjectors),
        wallStartedAt,
        ...(finalContext !== undefined ? { finalContext } : {}),
        ...(capabilityState !== undefined ? { capabilityState } : {}),
        ...(hostMetadata === undefined ? {} : { hostMetadata }),
        ...(authority === undefined
          ? {}
          : { operatorAuthorityState: authority.finalize(response) }),
      });

      try {
        await deps.traceStore.insert(record);
        journal?.discard();
      } catch (persistErr) {
        if (isExecutionIdConflict(persistErr)) {
          throw persistErr;
        }
        runLogger?.error(
          {
            event: "run.persist_failed",
            status: record.status,
            iterations_used: response.usage.iterations_used,
            cause: sanitizeErrorMessage(
              persistErr instanceof Error ? persistErr.message : String(persistErr),
            ),
          },
          "the execution completed but its trace could not be persisted; the caller sees an error",
        );
        throw new PersistenceError();
      }

      const pending: Promise<unknown>[] = [];
      for (const c of runCapabilities) {
        try {
          const settled = c.onRunEnd?.(record);
          if (settled !== undefined) {
            pending.push(
              settled.catch((err: unknown) => {
                runLogger?.warn(
                  {
                    event: "capability.run_end_failed",
                    capability: c.name,
                    cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
                  },
                  "capability_run_end_failed: onRunEnd rejected; the run is unaffected",
                );
              }),
            );
          }
        } catch (err) {
          runLogger?.warn(
            {
              event: "capability.run_end_failed",
              capability: c.name,
              cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
            },
            "capability_run_end_failed: onRunEnd threw; the run is unaffected",
          );
        }
      }
      if (pending.length > 0) {
        await raceWithBudget(
          Promise.all(pending),
          deps.env.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS,
          () =>
            runLogger?.warn(
              { event: "capability.run_end_timeout" },
              "capability_run_end_timeout: durable run-end work exceeded its budget; it continues detached",
            ),
        );
      }

      return { executionId, response };
    } finally {
      authority?.finalize({ status: "cancelled" });
      externalSignal?.removeEventListener("abort", onExternalAbort);
      journal?.close();
    }
  } finally {
    releaseExecutionId();
  }
}
