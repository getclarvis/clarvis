import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import { generateExecutionId } from "@clarvis/trace";
import type {
  Page,
  Pagination,
  RunEvent,
  RunHandle,
  RunCompactionResult,
  RunResult,
  RunService,
  RunSummary,
  StartRunParams,
} from "@clarvis/protocol";
import type { EventStreamOptions } from "../core/event-stream.ts";
import { DEFAULT_INGEST_CLOSE_GRACE_MS } from "./memory-ingest-phase.ts";
import {
  capabilityEventToProto,
  engineEventToProto,
  nativeConfigurationEventToProto,
} from "./map-events.ts";
import {
  engineResultToProto,
  nativeConfigurationResultToProto,
  storedToDetail,
  summaryToProto,
} from "./map-result.ts";
import { kernelError } from "../core/errors.ts";
import { createManagedRun } from "./managed-run.ts";
import type { KernelLifecycle } from "../application/lifecycle.ts";
import { normalizeRunPagination } from "./pagination.ts";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { SteerQueue } from "./steer-queue.ts";
import type { NativeConfigurationRuns } from "../configuration/native-configuration.ts";
import type { GoalExecutionPolicy } from "../goals/hosted-turn.ts";

/**
 * Builds the engine run request body from protocol start params (after `execution_id` is assigned).
 */
export type RunRequestAssembler = (params: StartRunParams & { execution_id: string }) => unknown;

/** Trusted host preparation; never accepted as a protocol start parameter. */
export type PreparedRunExecution =
  | { kind: "ordinary"; rawBody: unknown; goal?: GoalExecutionPolicy }
  | { kind: "workflow"; start(): RunHandle };

/** Run service with a host-only prepared launch sharing ordinary execution-id reservations. */
export interface KernelRunService extends RunService {
  start(params: StartRunParams, prepared?: PreparedRunExecution): Promise<RunHandle>;
}

/** Placement-neutral execution port; native remains the lazy default. */
export type RunExecutorArgs = Omit<ExecuteRunArgs, "steer"> & {
  /** Kernel queues transfer acknowledgements across placement without prematurely draining them. */
  readonly steer?: NonNullable<ExecuteRunArgs["steer"]> & Partial<Pick<SteerQueue, "take">>;
  /** Host-admitted parent whose same-guest child composition owns this run's controls and budget. */
  readonly runtimeParentRunId?: string;
};
export type RunExecutor = (args: RunExecutorArgs) => Promise<ExecuteRunOutcome>;

/** Configuration for {@link createRunService}. */
export interface RunServiceConfig {
  /** Engine dependencies passed to `executeRun`; its `traceStore` also backs
   * this service's list/get/delete. */
  deps: ExecuteRunDeps;
  /** Owner scope every trace-store read and write is keyed under. */
  owner: string;
  /** Builds the engine run request body from protocol start params. */
  assembleRunRequest: RunRequestAssembler;
  /** True when this run's entry agent profile carries the `workflow` grant, so
   * `start` must route it through {@link RunServiceConfig.runManagerWorkflow}
   * instead of a plain run. Injected by the kernel (which resolves the profile's
   * grants); absent for hosts that do not wire workflows. */
  isManagerRun?: (params: StartRunParams) => boolean;
  /** Runs a manager turn as a workflow, returning the same {@link RunHandle}. Called
   * by `start` only when {@link RunServiceConfig.isManagerRun} returns true. */
  runManagerWorkflow?: (params: StartRunParams & { execution_id: string }) => RunHandle;
  /** How long the event stream lingers, after each `memory_ingest` notice, for
   * the next one to arrive before giving up. Test override; defaults to
   * {@link DEFAULT_INGEST_CLOSE_GRACE_MS}. */
  ingestGraceMs?: number;
  /** Event-stream backpressure. Defaults to a {@link DEFAULT_RUN_EVENT_BUFFER}
   * buffer that coalesces adjacent deltas and, only when that is not enough,
   * drops the oldest droppable one. Fields are merged individually against
   * that default — pass `{ maxBuffered: 0 }` alone to restore an unbounded
   * buffer without losing the default `coalesce`/`droppable`, or override any
   * subset of the count, byte, coalescing and drop fields. Setting only
   * `maxBuffered: 0` disables the count cap but leaves the default byte cap in
   * place; both caps must be set to `0` to request an unbounded host override.
   *
   * @remarks A supplied `droppable` is narrowed so the terminal
   * `events_dropped` notice is never itself discarded — the report of what the
   * policy dropped cannot be one of its casualties. */
  eventBuffer?: EventStreamOptions<RunEvent>;
  /** Kernel lifecycle that owns active runs and rejects starts during shutdown. */
  lifecycle?: KernelLifecycle;
  /** Where an event with no protocol projection is reported. */
  logger?: Logger;
  /** Executes the loop natively or through an explicitly configured isolated runtime. */
  executeRun?: RunExecutor;
  /** Explicitly approved host-only route for the shipped configuration skill. */
  nativeConfiguration?: NativeConfigurationRuns;
}

/**
 * Protocol {@link RunService} over loop execution: start/stream/steer/cancel, plus trace store list/get/delete.
 *
 * @param cfg - engine deps, owner scope, request assembler, and optional ingest
 *   grace; see {@link RunServiceConfig}.
 * @returns a {@link RunService} whose `start` launches a run in the background
 *   and hands back a {@link RunHandle} (event stream, steer, cancel, elicit
 *   respond/subscribe, and a `done` result promise), and whose `get`/`list`/
 *   `delete` read the trace store.
 * @remarks Both event paths are folded into one stream: `engineEventToProto` for
 *   trace events and `capabilityEventToProto` for plan/delegation/memory events,
 *   each pushed only when it maps to a non-`null` protocol event. `start`
 *   rejects before launch when its owner already has the requested id active or
 *   persisted; assembly and execution failures after reservation instead
 *   resolve `done` to a failed {@link RunResult} via {@link failedResult}. On
 *   settle the stream stays open
 *   until an in-flight memory ingest posts its terminal notice, or `ingestGraceMs`
 *   elapses with no further notice — each non-terminal notice (a `"started"` or
 *   a retry-driven re-`"queued"`) restarts that wait, so a job backing off
 *   through several retries is not cut off after only its first gap. `get`/`delete`
 *   throw a `not_found` kernel error for an unknown id.
 *
 *   One owner-scoped service is shared by every connection to that owner. It
 *   reserves an execution id before constructing a handle, preventing a
 *   duplicate launch from sharing trace or remote-mutation identity.
 */
export function createRunService(cfg: RunServiceConfig): KernelRunService {
  const { deps, owner, assembleRunRequest } = cfg;
  const logger = cfg.logger ?? NOOP_LOGGER;
  const ingestGraceMs = cfg.ingestGraceMs ?? DEFAULT_INGEST_CLOSE_GRACE_MS;
  const store = deps.traceStore;
  const activeIds = new Set<string>();
  const activeHandles = new Map<string, RunHandle>();

  function startReserved(
    params: StartRunParams,
    executionId: string,
    prepared?: PreparedRunExecution,
  ): RunHandle {
    const configuration = cfg.nativeConfiguration?.requested(params) === true;
    if (!configuration && prepared?.kind === "workflow") return prepared.start();
    if (
      !configuration &&
      prepared === undefined &&
      cfg.runManagerWorkflow !== undefined &&
      cfg.isManagerRun?.(params) === true
    ) {
      return cfg.runManagerWorkflow({ ...params, execution_id: executionId });
    }
    return createManagedRun({
      executionId,
      eventBuffer: cfg.eventBuffer,
      ingestGraceMs,
      lifecycle: cfg.lifecycle,
      async execute(context): Promise<RunResult> {
        const goal = prepared?.kind === "ordinary" ? prepared.goal : undefined;
        const request = { ...params, execution_id: executionId };
        const executeRun =
          cfg.executeRun ??
          (async (args: ExecuteRunArgs) => (await import("@clarvis/loop")).executeRun(args));
        const args: Omit<RunExecutorArgs, "rawBody"> = {
          owner,
          deps:
            goal === undefined
              ? deps
              : {
                  ...deps,
                  llm: goal.trackModel(deps.llm),
                  capabilities: [...(deps.capabilities ?? []), goal.capability],
                },
          onEvent: (ev) => {
            goal?.observe(ev);
            const mapped = configuration
              ? nativeConfigurationEventToProto(ev, logger)
              : engineEventToProto(ev, logger);
            if (mapped !== null) context.emit(mapped);
          },
          onCapabilityEvent: (event) => {
            const mapped = capabilityEventToProto(event, logger);
            if (mapped !== null) context.emit(mapped);
          },
          steer: context.steer,
          compaction: context.compaction,
          externalSignal: context.signal,
          elicit: context.elicit,
        };
        const outcome = configuration
          ? await cfg.nativeConfiguration!.execute(request, args)
          : await executeRun({
              ...args,
              rawBody:
                prepared?.kind === "ordinary" ? prepared.rawBody : assembleRunRequest(request),
            });
        return configuration
          ? nativeConfigurationResultToProto(outcome.executionId, outcome.response)
          : engineResultToProto(outcome.executionId, outcome.response);
      },
    });
  }

  return {
    async start(params: StartRunParams, prepared?: PreparedRunExecution): Promise<RunHandle> {
      const executionId = params.execution_id ?? generateExecutionId();
      if (activeIds.has(executionId) || store.existsForOwner(owner, executionId)) {
        throw kernelError("conflict", `run '${executionId}' already exists for this owner`);
      }
      activeIds.add(executionId);
      try {
        const handle = startReserved(params, executionId, prepared);
        activeHandles.set(executionId, handle);
        const release = (): void => {
          activeIds.delete(executionId);
          if (activeHandles.get(executionId) === handle) activeHandles.delete(executionId);
        };
        // `done` settles before the managed stream's optional ingest grace.
        // Keep the id reserved until both model execution and event delivery
        // finish, otherwise a same-id retry can overlap late capability events
        // and write into the first run's trace/lifecycle scope.
        void handle.closed.then(release, release);
        return handle;
      } catch (error) {
        activeIds.delete(executionId);
        throw error;
      }
    },
    async compact(
      executionId: string,
      request?: string,
      options?: { mechanical_target_tokens?: number },
    ): Promise<RunCompactionResult> {
      const mechanicalTarget = options?.mechanical_target_tokens;
      if (
        mechanicalTarget !== undefined &&
        (!Number.isSafeInteger(mechanicalTarget) || mechanicalTarget <= 0)
      ) {
        throw kernelError("invalid_request", "mechanical_target_tokens must be a positive integer");
      }
      const active = activeHandles.get(executionId);
      if (active !== undefined) {
        if (mechanicalTarget !== undefined) {
          throw kernelError("invalid_request", "mechanical context fitting requires a settled run");
        }
        await active.compact(request);
        return { status: "queued", execution_id: executionId };
      }
      const stored = store.getById(owner, executionId);
      if (stored === null) throw kernelError("not_found", `run '${executionId}' not found`);
      if (stored.final_context === undefined || stored.final_context.length === 0) {
        return { status: "skipped", execution_id: executionId, reason: "no_context" };
      }
      if (mechanicalTarget !== undefined) {
        const { fitStoredContextToWindow } = await import("@clarvis/loop");
        const fitted = fitStoredContextToWindow(
          stored.final_context,
          mechanicalTarget,
          deps.env,
          logger,
        );
        if (fitted.status === "skipped") {
          return { status: "skipped", execution_id: executionId, reason: fitted.reason };
        }
        const replaced = await store.replaceFinalContext(owner, executionId, fitted.context);
        if (!replaced) throw kernelError("not_found", `run '${executionId}' not found`);
        return {
          status: "compacted",
          execution_id: executionId,
          freed_chars: fitted.freedChars,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        };
      }
      const { compactStoredContext } = await import("@clarvis/loop");
      const outcome = await compactStoredContext({
        context: stored.final_context,
        request: stored.request,
        ...(request?.trim() ? { guidance: request.trim() } : {}),
        env: deps.env,
        llm: deps.llm,
        logger,
      });
      if (outcome.status === "skipped") {
        if (
          outcome.usage.input !== 0 ||
          outcome.usage.output !== 0 ||
          outcome.usage.cached !== 0 ||
          outcome.usage.cache_write !== 0
        ) {
          const retained = await store.replaceFinalContext(
            owner,
            executionId,
            stored.final_context,
            outcome.usage,
          );
          if (!retained) throw kernelError("not_found", `run '${executionId}' not found`);
        }
        return {
          status: "skipped",
          execution_id: executionId,
          reason: outcome.reason,
        };
      }
      const replaced = await store.replaceFinalContext(
        owner,
        executionId,
        outcome.context,
        outcome.usage,
      );
      if (!replaced) throw kernelError("not_found", `run '${executionId}' not found`);
      return {
        status: "compacted",
        execution_id: executionId,
        freed_chars: outcome.freedChars,
        usage: {
          input_tokens: outcome.usage.input,
          output_tokens: outcome.usage.output,
          cached_tokens: outcome.usage.cached,
          cache_write_tokens: outcome.usage.cache_write,
        },
      };
    },
    async context(executionId, targetWindowTokens) {
      if (
        targetWindowTokens !== undefined &&
        (!Number.isSafeInteger(targetWindowTokens) || targetWindowTokens <= 0)
      ) {
        throw kernelError("invalid_request", "target_window_tokens must be a positive integer");
      }
      const stored = store.getById(owner, executionId);
      if (stored === null) throw kernelError("not_found", `run '${executionId}' not found`);
      const context = stored.final_context ?? [];
      const { estimateStoredContextTokens } = await import("@clarvis/loop");
      const estimatedTokens = estimateStoredContextTokens(context);
      return {
        execution_id: executionId,
        estimated_tokens: estimatedTokens,
        has_context: context.length > 0,
        ...(targetWindowTokens === undefined
          ? {}
          : {
              high_water_tokens: Math.floor(
                targetWindowTokens * deps.env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION,
              ),
              requires_compaction:
                estimatedTokens >
                Math.floor(
                  targetWindowTokens * deps.env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION,
                ),
            }),
      };
    },
    async get(executionId: string): Promise<RunDetailReturn> {
      const row = store.getById(owner, executionId);
      if (row === null) throw kernelError("not_found", `run '${executionId}' not found`);
      return storedToDetail(row, logger);
    },
    async list(page?: Pagination): Promise<Page<RunSummary>> {
      const { limit, offset } = normalizeRunPagination(page);
      const { items, total } = store.list(owner, limit, offset);
      return { items: items.map(summaryToProto), total, limit, offset };
    },
    async delete(executionId: string): Promise<void> {
      const ok = store.deleteById(owner, executionId);
      if (!ok) throw kernelError("not_found", `run '${executionId}' not found`);
    },
  };
}

/** The resolved return type of {@link RunService.get}, reused as the internal
 * `get` implementation's return annotation. */
type RunDetailReturn = Awaited<ReturnType<RunService["get"]>>;
