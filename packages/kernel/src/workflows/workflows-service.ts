import {
  bind,
  isBuiltinTraceEvent,
  NOOP_LOGGER,
  type ExecutionStatus,
  type TraceEvent,
} from "@clarvis/capability";
import type { ExecuteRunDeps, RunRequest } from "@clarvis/loop";
import { generateExecutionId } from "@clarvis/trace";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { MEMORY_CAPABILITY_NAME } from "@clarvis/memory/settings";
import {
  createElicitMux,
  createWorkflowSemaphore,
  createWorkflowLedger,
  createWorkflowLeaderCount,
  createWorkflowsCapability,
  isWorkflowPersistedTraceEvent,
  managerLiveChildrenFloor,
  resolveWorkflowDefinitions,
  type LeaderProfileInfo,
  type LeaderRequestAssembler,
  type WorkflowCtx,
  type WorkflowRunDeps,
} from "@clarvis/workflows";
import { loadWorkflows } from "@clarvis/workflows/artifact";
import type {
  Page,
  Pagination,
  RunEvent,
  RunHandle,
  RunResult,
  RunStatus,
  StartRunParams,
  WorkflowDetail,
  WorkflowNode,
  WorkflowSequence,
  WorkflowSummary,
  WorkflowsService,
} from "@clarvis/protocol";
import type { EventStreamOptions } from "../core/event-stream.ts";
import { kernelError } from "../core/errors.ts";
import { capabilityEventToProto, engineEventToProto } from "../runs/map-events.ts";
import { DEFAULT_INGEST_CLOSE_GRACE_MS } from "../runs/memory-ingest-phase.ts";
import { engineResultToProto } from "../runs/map-result.ts";
import type { RunExecutor, RunExecutorArgs, RunRequestAssembler } from "../runs/run-service.ts";
import { createManagedRun } from "../runs/managed-run.ts";
import {
  WORKFLOW_MAX_EDGES,
  WORKFLOW_MAX_ERROR_BYTES,
  WORKFLOW_MAX_REASON_BYTES,
  WORKFLOW_MAX_TITLE_BYTES,
  WORKFLOW_PAGE_DEFAULT,
  boundedWorkflowEdge,
  boundedWorkflowSequence,
  createWorkflowSaveQueue,
  markWorkflowEdgesTruncated,
  normalizeWorkflowPage,
  truncateWorkflowText,
  type WorkflowEdge,
  type WorkflowPersistenceRuntime,
  type WorkflowPageScanOptions,
  type WorkflowRecord,
  type WorkflowRecordSummary,
  type WorkflowSequenceRecord,
  type WorkflowStore,
} from "./workflow-store.ts";
import type { KernelLifecycle } from "../application/lifecycle.ts";
import { generateWorkflowTitle } from "./workflow-title.ts";

const WORKFLOW_RUN_DEPS = {
  executeRun: async (args) => (await import("@clarvis/loop")).executeRun(args),
  generateExecutionId,
} satisfies WorkflowRunDeps;

/** The resolved `workflows` fan-out settings a manager run executes under.
 * Manager designation is the `workflow` grant, not a field here. */
export interface WorkflowsRuntimeSettings {
  max_concurrency: number;
  max_total_leaders: number;
  budget_tokens: number | null;
}

/** Configuration for {@link createWorkflowsService}. */
export interface WorkflowsServiceConfig {
  /** Engine deps `executeRun` drives (shared with the run service). */
  deps: ExecuteRunDeps;
  /** Placement-neutral loop executor used by manager and leader runs. */
  executeRun?: RunExecutor;
  /** Owner scope every run and record is keyed under. */
  owner: string;
  /** Workspace label stamped on each {@link WorkflowRecord}. */
  workspace: string;
  /** The global root workflow documents are discovered under, alongside the
   * workspace's own. Omitted in tests, where only the workspace root matters. */
  globalConfigDir?: string;
  /** The base settings assembler, reused for the manager and (grant-stripped, plans-off) each leader. */
  assembleRunRequest: RunRequestAssembler;
  /** The workflow record store (edges + rollup persistence). */
  store: WorkflowStore;
  /** Reads the merged `workflows` fan-out settings per start. */
  readSettings: () => WorkflowsRuntimeSettings;
  /** Resolves the manager-selectable leader profiles for the `run_leader` enum. */
  leaderProfiles?: () => readonly LeaderProfileInfo[];
  /** Resolves the default profile a leader runs as when a `run_leader` call omits
   * `profile` — the manager's own `default_spawn`, so a leader never inherits the
   * manager's own persona. Returns `undefined` when the manager has no
   * `default_spawn`, in which case the leader falls back to the manager agent. */
  resolveLeaderDefault?: (managerAgent?: string) => string | undefined;
  /** How long the event stream lingers, after each `memory_ingest` notice, for
   * the next one to arrive before giving up. Test override; defaults to
   * {@link DEFAULT_INGEST_CLOSE_GRACE_MS}. */
  ingestGraceMs?: number;
  /** Event-stream backpressure, mirroring {@link import("../runs/run-service.ts").RunServiceConfig.eventBuffer}
   * — the workflow stream carries the manager's own full transcript (not just the
   * `workflow_run_*` edges), so it has the identical slow-consumer concern.
   * Defaults to the same {@link DEFAULT_RUN_EVENT_BUFFER} coalesce/drop policy. */
  eventBuffer?: EventStreamOptions<RunEvent>;
  /** Kernel lifecycle that owns active manager runs. */
  lifecycle?: KernelLifecycle;
  /** Coalescing delay for event-driven record snapshots. Internal test override. */
  persistenceDelayMs?: number;
  /** Deterministic persistence clock. Internal test seam. */
  persistenceRuntime?: WorkflowPersistenceRuntime;
}

/** The kernel-internal workflows surface: the protocol {@link WorkflowsService}
 * control plane (`get`/`list`/`delete`) plus {@link runManagerWorkflow}, which the
 * run service calls to execute a manager turn. `runManagerWorkflow` is deliberately
 * NOT on the protocol interface — clients start a workflow through
 * `RunService.start`; the kernel routes by the entry profile's `workflow` grant. */
export interface KernelWorkflowsService extends WorkflowsService {
  /** Internal transport metadata for cancelling a potentially large catalog scan. */
  list(page?: Pagination, scan?: WorkflowPageScanOptions): Promise<Page<WorkflowSummary>>;
  /** Run one manager turn as a workflow: execute the manager with the `workflows`
   * capability injected, persist its tree record, and return the run handle. */
  runManagerWorkflow(params: StartRunParams, prepared?: PreparedWorkflowExecution): RunHandle;
}

/** Admission-time configuration for a hosted manager and all its subsequently admitted leaders. */
export interface PreparedWorkflowExecution {
  managerBody: unknown;
  assembleRunRequest: RunRequestAssembler;
  settings: WorkflowsRuntimeSettings;
  leaderProfiles: readonly LeaderProfileInfo[];
  defaultLeader?: string;
}

/** The loose shape of an engine run request body this service post-processes. */
interface RunRequestBody {
  profiles?: Array<{ grants?: string[] }>;
  execution_id?: string;
  elicit_wait_ms?: number;
  [key: string]: unknown;
}

/**
 * Build the engine deps for an auxiliary workflow run.
 *
 * @param deps - the primary run's engine dependencies.
 * @returns a shallow copy whose capability list cannot activate execution memory.
 * @remarks A workflow leader is a separate run, not a delegated agent inside the
 *   primary run. It must neither read/write memory nor enqueue its own index job;
 *   the manager remains the single memory-producing run for the workflow.
 */
function auxiliaryWorkflowRunDeps(deps: ExecuteRunDeps): ExecuteRunDeps {
  const capabilities = (deps.capabilities ?? []).filter(
    (capability) => capability.name !== MEMORY_CAPABILITY_NAME,
  );
  return { ...deps, capabilities };
}

/**
 * Kernel workflows surface over loop execution: {@link KernelWorkflowsService.runManagerWorkflow}
 * runs the manager with the `workflows` capability injected (so its `run_leader`
 * calls spawn isolated leader runs bounded by a shared semaphore + token ledger),
 * while `get`/`list`/`delete` read the {@link WorkflowStore}.
 *
 * @param cfg - engine deps, owner/workspace scope, the base assembler, the record
 *   store, and the settings/profile resolvers; see {@link WorkflowsServiceConfig}.
 * @returns the service.
 * @remarks The `workflow_run_*` edges reach the client (and rehydrate) through the
 *   manager's engine trace — this service does not touch the capability channel for
 *   them. Leaders run WITHOUT the workflows capability and with the `workflow`
 *   grant stripped + planning forced off, which fixes the three-level topology.
 */
export function createWorkflowsService(cfg: WorkflowsServiceConfig): KernelWorkflowsService {
  const runDeps: WorkflowRunDeps = {
    executeRun: cfg.executeRun ?? WORKFLOW_RUN_DEPS.executeRun,
    generateExecutionId,
  };
  const { deps, owner, assembleRunRequest, store } = cfg;
  const ingestGraceMs = cfg.ingestGraceMs ?? DEFAULT_INGEST_CLOSE_GRACE_MS;

  const readTerminalEvidence = (executionId: string): WorkflowTerminalEvidence | null => {
    try {
      return deps.traceStore.getById(owner, executionId);
    } catch (error) {
      deps.logger?.warn(
        { operation: "workflow.reconcile", executionId, error },
        "workflow reconciliation could not read the root trace",
      );
      return null;
    }
  };

  const reconcilePersisted = (
    record: WorkflowRecord,
    knownEvidence?: WorkflowTerminalEvidence | null,
  ): WorkflowRecord => {
    if (record.status !== "running") return record;
    const execution =
      knownEvidence === undefined ? readTerminalEvidence(record.root_run_id) : knownEvidence;
    const repaired = reconcileRunningWorkflowRecord(record, execution);
    if (repaired === record) return record;
    try {
      store.save(repaired);
    } catch (error) {
      // Return the truthful projection for this read. The persisted record stays
      // retryable and the next get/list will attempt the repair again.
      deps.logger?.warn(
        { operation: "workflow.reconcile", executionId: record.id, error },
        "workflow reconciliation could not persist the repaired record",
      );
      return repaired;
    }
    deps.logger?.info(
      {
        operation: "workflow.reconcile",
        executionId: record.id,
        recovered: 1,
        status: repaired.status,
      },
      "reconciled a running workflow from its terminal root trace",
    );
    return repaired;
  };

  /**
   * Resolve the built-in workflows and any operator-authored overrides.
   *
   * @remarks Read per run rather than once, so authoring a workflow does not need
   * a restart — the same instinct `refresh()` serves in `@clarvis/skills`. The
   * roots are in ascending precedence, so a global document overrides a built-in
   * and a workspace document overrides both. `@clarvis/workflows` never resolves a root itself:
   * `@clarvis/paths` owns the directory vocabulary and the kernel is what already
   * depends on it.
   */
  const readWorkflowDefs = (): ReturnType<typeof loadWorkflows>["workflows"] => {
    const roots = [
      globalPaths(cfg.globalConfigDir).workflowsDir,
      workspacePaths(cfg.workspace).workflowsDir,
    ];
    const registry = loadWorkflows(roots);
    for (const failure of registry.errors) {
      deps.logger?.warn({ dir: failure.dir, err: failure.message }, "workflows: skipping document");
    }
    return resolveWorkflowDefinitions(registry.workflows);
  };

  function runManagerWorkflow(
    params: StartRunParams,
    prepared?: PreparedWorkflowExecution,
  ): RunHandle {
    const settings = prepared?.settings ?? cfg.readSettings();
    const assemble = prepared?.assembleRunRequest ?? assembleRunRequest;

    const managerRunId = params.execution_id ?? generateExecutionId();

    const maxConcurrency = settings.max_concurrency;
    const maxTotalLeaders = settings.max_total_leaders;
    const budgetTokens = settings.budget_tokens;
    const semaphore = createWorkflowSemaphore(maxConcurrency);
    const ledger = createWorkflowLedger(budgetTokens);
    const leaderCount = createWorkflowLeaderCount(maxTotalLeaders);
    let budgetExhausted = false;

    const startedAt = Date.now();
    const title = truncateWorkflowText(
      provisionalWorkflowTitle(managerRunId),
      WORKFLOW_MAX_TITLE_BYTES,
      "title",
    );
    const record: WorkflowRecord = {
      id: managerRunId,
      root_run_id: managerRunId,
      title,
      workspace: cfg.workspace,
      status: "running",
      created_at: startedAt,
      updated_at: startedAt,
      edges: [
        {
          run_id: managerRunId,
          kind: "manager",
          ...(params.agent !== undefined ? { profile: params.agent } : {}),
          title,
          status: "running",
          started_at: startedAt,
        },
      ],
      output_tokens: 0,
    };
    store.save(record);

    const edgesByRunId = new Map(record.edges.map((edge) => [edge.run_id, edge]));
    const persistSnapshot = (): void => {
      store.save(record);
    };
    const saves = createWorkflowSaveQueue({
      save: persistSnapshot,
      ...(cfg.persistenceDelayMs === undefined ? {} : { delayMs: cfg.persistenceDelayMs }),
      ...(cfg.persistenceRuntime === undefined ? {} : { runtime: cfg.persistenceRuntime }),
      onBackgroundError(error) {
        deps.logger?.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "workflows: coalesced record save failed; terminal flush will retry",
        );
      },
    });

    const persist = (): void => {
      record.output_tokens = ledger.spent();
      record.updated_at = Date.now();
      saves.request();
    };

    const observe = (event: RunEvent): void => {
      if (event.type === "workflow_run_started") {
        if (edgesByRunId.has(event.run_id)) return;
        if (record.edges.length >= WORKFLOW_MAX_EDGES) {
          markWorkflowEdgesTruncated(record);
          persist();
          return;
        }
        const edge = boundedWorkflowEdge({
          run_id: event.run_id,
          parent_run_id: event.parent_run_id,
          kind: "leader",
          ...(event.profile !== undefined ? { profile: event.profile } : {}),
          title: event.title,
          task: event.task,
          ...(event.round_id !== undefined ? { round_id: event.round_id } : {}),
          ...(event.pass !== undefined ? { pass: event.pass } : {}),
          ...(event.item_index !== undefined ? { item_index: event.item_index } : {}),
          ...(event.replica !== undefined ? { replica: event.replica } : {}),
          ...(event.replica_count !== undefined ? { replica_count: event.replica_count } : {}),
          status: "running",
          started_at: event.at,
        });
        record.edges.push(edge);
        edgesByRunId.set(edge.run_id, edge);
        persist();
      } else if (event.type === "workflow_title_updated") {
        record.title = truncateWorkflowText(event.title, WORKFLOW_MAX_TITLE_BYTES, "title");
        const root = edgesByRunId.get(managerRunId);
        if (root !== undefined) root.title = record.title;
        persist();
      } else if (event.type === "workflow_run_completed" || event.type === "workflow_run_failed") {
        const edge = edgesByRunId.get(event.run_id);
        if (edge !== undefined) {
          edge.status = event.status;
          edge.ended_at = event.at;
          if (event.type === "workflow_run_failed") {
            if (event.error === undefined) delete edge.error;
            else {
              edge.error = {
                code: truncateWorkflowText(event.error.code, 256, "error code"),
                message: truncateWorkflowText(
                  event.error.message,
                  WORKFLOW_MAX_ERROR_BYTES,
                  "error message",
                ),
              };
            }
            edge.reason = truncateWorkflowText(
              event.error?.message ?? event.status,
              WORKFLOW_MAX_REASON_BYTES,
              "reason",
            );
          }
          persist();
        }
      }
    };

    const assembleLeader: LeaderRequestAssembler = (spec) => {
      const leaderAgent =
        spec.profile ??
        (prepared === undefined
          ? cfg.resolveLeaderDefault?.(params.agent)
          : prepared.defaultLeader) ??
        params.agent;
      const leaderParams: StartRunParams & { execution_id: string } = {
        execution_id: "",
        messages: [{ role: "user", content: spec.prompt }],
        plans: "off",
        memory: "off",
        ...(leaderAgent !== undefined ? { agent: leaderAgent } : {}),
        ...(spec.expectSchema !== undefined ? { output_schema: spec.expectSchema } : {}),
        ...(params.guard_mode !== undefined ? { guard_mode: params.guard_mode } : {}),
        ...(params.guard_judge !== undefined ? { guard_judge: params.guard_judge } : {}),
        ...(params.task !== undefined ? { task: params.task } : {}),
        ...(params.prompt_cache_key !== undefined
          ? { prompt_cache_key: params.prompt_cache_key }
          : {}),
        ...(params.prompt_cache_ttl !== undefined
          ? { prompt_cache_ttl: params.prompt_cache_ttl }
          : {}),
      };
      const body = assemble(leaderParams) as RunRequestBody;
      stripWorkflowGrant(body);
      return body as unknown as RunRequest;
    };

    function finalize(status: RunStatus): void {
      const endedAt = Date.now();
      closeManagerEdge(record.edges, managerRunId, status, endedAt);
      const aggregateStatus = finalWorkflowStatus(status, budgetExhausted, record.edges);
      record.status = aggregateStatus;
      if (record.sequence !== undefined) {
        record.sequence = terminalWorkflowSequence(record.sequence, status);
      }
      closeRunningEdges(record.edges, aggregateStatus, endedAt);
      persist();
      saves.flush();
    }

    return createManagedRun({
      executionId: managerRunId,
      eventBuffer: cfg.eventBuffer,
      ingestGraceMs,
      lifecycle: cfg.lifecycle,
      observe,
      settle(result) {
        finalize(result.status);
      },
      async execute(context): Promise<RunResult> {
        /**
         * The engine deps every leader of this workflow runs against.
         *
         * @remarks The one place a workflow's correlation can be bound, because
         * it is the one place the tree's identity is known: `record.id`,
         * `record.root_run_id` and `managerRunId` are the same value, so there
         * is no separate workflow id to invent. Everything `@clarvis/workflows`
         * says below this point carries it, and a whole fan-out reads as one
         * tree rather than as unrelated runs.
         */
        const auxiliaryDeps = auxiliaryWorkflowRunDeps(deps);
        const workflowDeps: ExecuteRunDeps =
          auxiliaryDeps.logger === undefined
            ? auxiliaryDeps
            : {
                ...auxiliaryDeps,
                logger: bind(auxiliaryDeps.logger, {
                  component: "workflows",
                  workflow_id: managerRunId,
                }),
              };
        const mux = createElicitMux(context.elicit, {
          ...(workflowDeps.logger === undefined ? {} : { logger: workflowDeps.logger }),
        });
        const leaderProgress = new Map<string, LeaderProgress>();
        /**
         * Fold one leader event into that leader's running progress tallies.
         *
         * @remarks Recognizes workflow-owned persisted events before narrowing
         * engine built-ins. A leader cannot spawn another workflow manager, so
         * such an event contributes no leader progress here; all other
         * contributed events are ignored for the same reason. The explicit
         * workflow guard keeps this consumer aligned with the trace mapping
         * boundary rather than treating a now-contributed discriminator as an
         * engine built-in.
         */
        const onLeaderEvent = (leaderRunId: string, event: TraceEvent): void => {
          if (isWorkflowPersistedTraceEvent(event)) return;
          if (!isBuiltinTraceEvent(event)) return;
          if (event.type === "delegation_created") {
            const acc = leaderProgress.get(leaderRunId) ?? freshLeaderProgress();
            acc.delegatedIds.add(event.delegation_id);
            leaderProgress.set(leaderRunId, acc);
            return;
          }
          const mapped = engineEventToProto(event, deps.logger ?? NOOP_LOGGER);
          if (mapped === null || mapped.type !== "iteration_completed") return;
          const acc = leaderProgress.get(leaderRunId) ?? freshLeaderProgress();
          acc.input += mapped.input_tokens ?? 0;
          acc.output += mapped.output_tokens ?? 0;
          if (isLeaderEntryIteration(mapped, acc)) acc.iterations += 1;
          leaderProgress.set(leaderRunId, acc);
          context.emit({
            type: "workflow_run_progress",
            at: Date.now(),
            run_id: leaderRunId,
            parent_run_id: managerRunId,
            iterations: acc.iterations,
            input_tokens: acc.input,
            output_tokens: acc.output,
          });
        };
        const managerBody = (prepared?.managerBody ??
          assemble({
            execution_id: managerRunId,
            messages: params.messages,
            ...(params.agent !== undefined ? { agent: params.agent } : {}),
            ...(params.guard_mode !== undefined ? { guard_mode: params.guard_mode } : {}),
            ...(params.guard_judge !== undefined ? { guard_judge: params.guard_judge } : {}),
            ...(params.memory !== undefined ? { memory: params.memory } : {}),
            ...(params.task !== undefined ? { task: params.task } : {}),
            ...(params.plans !== undefined ? { plans: params.plans } : {}),
            ...(params.output_schema !== undefined ? { output_schema: params.output_schema } : {}),
            ...(params.prompt_cache_key !== undefined
              ? { prompt_cache_key: params.prompt_cache_key }
              : {}),
            ...(params.prompt_cache_ttl !== undefined
              ? { prompt_cache_ttl: params.prompt_cache_ttl }
              : {}),
          })) as RunRequestBody;
        const workflowContext: WorkflowCtx = {
          deps: workflowDeps,
          runDeps,
          owner,
          semaphore,
          ledger,
          leaderCount,
          maxConcurrency,
          maxParallelSubagents: workflowDeps.env.CLARVIS_MAX_PARALLEL_SUBAGENTS,
          elicitWaitMs:
            managerBody.elicit_wait_ms ?? workflowDeps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS,
          assemble: assembleLeader,
          managerRunId,
          signal: context.signal,
          elicitForLeader: (runId: string) => mux.forLeader(runId),
          onLeaderEvent,
          onBudgetExhausted: () => {
            budgetExhausted = true;
          },
          onSequenceState: (state) => {
            const sequence: WorkflowSequenceRecord = boundedWorkflowSequence({
              session_id: state.sessionId,
              status: state.status,
              revision: state.revision,
              ...(state.roundId === undefined ? {} : { round_id: state.roundId }),
              ...(state.pass === undefined ? {} : { pass: state.pass }),
              ...(state.nextRoundId === undefined ? {} : { next_round_id: state.nextRoundId }),
              ...(state.nextPass === undefined ? {} : { next_pass: state.nextPass }),
              leaders_started: state.leadersStarted,
              max_total_leaders: state.maxTotalLeaders,
              ...(state.reason === undefined ? {} : { reason: state.reason }),
            });
            record.sequence = sequence;
            persist();
            context.emit({
              type: "workflow_sequence_state",
              at: Date.now(),
              run_id: managerRunId,
              ...sequence,
            });
          },
          ...(prepared !== undefined
            ? { leaderProfiles: prepared.leaderProfiles }
            : cfg.leaderProfiles !== undefined
              ? { leaderProfiles: cfg.leaderProfiles() }
              : {}),
          workflowDefs: readWorkflowDefs(),
        };
        const workflowsCap = createWorkflowsCapability(workflowContext);
        raiseLiveChildrenCeiling(managerBody, maxConcurrency);
        const titleTask = generateWorkflowTitle({
          request: managerBody as unknown as RunRequest,
          llm: deps.llm,
          signal: context.signal,
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        }).then((generated) => {
          if (generated === null) return;
          context.emit({
            type: "workflow_title_updated",
            at: Date.now(),
            run_id: managerRunId,
            title: generated,
          });
        });
        const managerArgs: RunExecutorArgs = {
          rawBody: managerBody,
          owner,
          deps,
          capabilities: [workflowsCap],
          onEvent: (ev) => {
            const mapped = engineEventToProto(ev, deps.logger ?? NOOP_LOGGER);
            if (mapped !== null) context.emit(mapped);
          },
          onCapabilityEvent: (event) => {
            const mapped = capabilityEventToProto(event, deps.logger ?? NOOP_LOGGER);
            if (mapped !== null) context.emit(mapped);
          },
          steer: context.steer,
          compaction: context.compaction,
          externalSignal: context.signal,
          elicit: mux.manager,
        };
        const runTask = runDeps.executeRun(managerArgs);
        const [run] = await Promise.allSettled([runTask, titleTask]);
        if (run.status === "rejected") throw run.reason;
        const outcome = run.value;
        return engineResultToProto(outcome.executionId, outcome.response);
      },
    });
  }

  return {
    runManagerWorkflow,
    async get(id: string): Promise<WorkflowDetail> {
      const record = store.get(id);
      if (record === null) throw kernelError("not_found", `workflow '${id}' not found`);
      return recordToDetail(reconcilePersisted(record));
    },
    async list(
      page?: Pagination,
      scan: WorkflowPageScanOptions = {},
    ): Promise<Page<WorkflowSummary>> {
      const { limit, offset } = normalizeWorkflowPage({
        limit: page?.limit ?? WORKFLOW_PAGE_DEFAULT,
        offset: page?.offset ?? 0,
      });
      if (store.listPage !== undefined) {
        const result = await store.listPage({ limit, offset }, scan);
        return {
          items: result.items.map((summary) => {
            if (summary.status !== "running") return storedSummaryToSummary(summary);
            // A workflow id is its manager/root run id. Most live summaries have
            // no terminal trace, so avoid materializing their full record bodies.
            const evidence = readTerminalEvidence(summary.id);
            if (evidence === null) return storedSummaryToSummary(summary);
            try {
              const record = store.get(summary.id);
              return record === null
                ? storedSummaryToSummary(summary)
                : recordToSummary(
                    reconcilePersisted(
                      record,
                      record.root_run_id === summary.id ? evidence : undefined,
                    ),
                  );
            } catch (error) {
              deps.logger?.warn(
                { operation: "workflow.reconcile", executionId: summary.id, error },
                "workflow reconciliation could not read a running record",
              );
              return storedSummaryToSummary(summary);
            }
          }),
          total: result.total,
          limit,
          offset,
        };
      }
      const all = store.list();
      const items = all
        .slice(offset, offset + limit)
        .map((record) => reconcilePersisted(record))
        .map(recordToSummary);
      return { items, total: all.length, limit, offset };
    },
    async delete(id: string): Promise<void> {
      if (!store.delete(id)) throw kernelError("not_found", `workflow '${id}' not found`);
    },
  };
}

/** Terminal trace evidence sufficient to repair a workflow orphaned by a hard process stop. */
export interface WorkflowTerminalEvidence {
  status: ExecutionStatus;
  ended_at: number;
}

/**
 * Close a manager-owned sequence that can no longer receive an Admiral decision.
 *
 * @remarks A normal completed manager already passes the coordinator finish gate,
 * which turns an awaiting checkpoint into `stopped`. This is the run-end backstop
 * for cancellation, failure, crash reconciliation and any future exit path that
 * bypasses that gate. Terminal coordinator snapshots preserve their own outcome.
 */
function terminalWorkflowSequence(
  sequence: WorkflowSequenceRecord,
  managerStatus: RunStatus,
): WorkflowSequenceRecord {
  if (sequence.status !== "running_round" && sequence.status !== "awaiting_manager") {
    return sequence;
  }
  const status =
    managerStatus === "cancelled"
      ? "cancelled"
      : managerStatus === "completed"
        ? "stopped"
        : "failed";
  const reason =
    status === "cancelled"
      ? "the Admiral run was cancelled before the sequence reached a terminal decision"
      : status === "stopped"
        ? "the Admiral finished without authorizing the sequence to continue"
        : "the Admiral run failed before the sequence reached a terminal decision";
  return boundedWorkflowSequence({
    session_id: sequence.session_id,
    status,
    revision: sequence.revision + 1,
    ...(sequence.round_id === undefined ? {} : { round_id: sequence.round_id }),
    ...(sequence.pass === undefined ? {} : { pass: sequence.pass }),
    leaders_started: sequence.leaders_started,
    max_total_leaders: sequence.max_total_leaders,
    reason,
  });
}

/**
 * Reconcile a still-running workflow record only when its root trace is already terminal.
 *
 * A fresh record is returned when repaired so a failed persistence retry cannot partially mutate
 * an in-memory store. Absent evidence and already-terminal records preserve object identity.
 */
export function reconcileRunningWorkflowRecord(
  record: WorkflowRecord,
  evidence: WorkflowTerminalEvidence | null,
): WorkflowRecord {
  if (record.status !== "running" || evidence === null) return record;
  const status: RunStatus =
    evidence.status === "completed"
      ? "completed"
      : evidence.status === "cancelled"
        ? "cancelled"
        : "failed";
  const repaired: WorkflowRecord = {
    ...record,
    status: "running",
    updated_at: evidence.ended_at,
    edges: record.edges.map((edge) => ({ ...edge })),
  };
  closeManagerEdge(repaired.edges, repaired.root_run_id, status, evidence.ended_at);
  if (repaired.sequence !== undefined) {
    repaired.sequence = terminalWorkflowSequence(repaired.sequence, status);
  }
  const aggregateStatus = finalWorkflowStatus(status, false, repaired.edges);
  repaired.status = aggregateStatus;
  closeRunningEdges(repaired.edges, aggregateStatus, evidence.ended_at);
  return repaired;
}

/**
 * Derive the aggregate workflow status from its primary run and auxiliary work.
 *
 * A completed manager cannot make a workflow successful when a leader failed,
 * remained unfinished, or could not start because the leader ledger was empty.
 */
export function finalWorkflowStatus(
  managerStatus: RunStatus,
  budgetExhausted: boolean,
  edges: readonly WorkflowEdge[],
): RunStatus {
  if (managerStatus !== "completed") return managerStatus;
  if (budgetExhausted) return "failed";
  return edges.some((edge) => edge.kind === "leader" && edge.status !== "completed")
    ? "failed"
    : "completed";
}

/** Close only the manager edge, preserving its own result when the aggregate fails. */
function closeManagerEdge(
  edges: WorkflowEdge[],
  managerRunId: string,
  status: RunStatus,
  endedAt: number,
): void {
  const manager = edges.find((edge) => edge.kind === "manager" && edge.run_id === managerRunId);
  if (manager?.status !== "running") return;
  manager.status = status;
  manager.ended_at = endedAt;
}

/**
 * Close every edge still `"running"` with the run's terminal `status`, stamping
 * `ended_at`; an edge already closed is left untouched. Exported for direct unit
 * testing.
 *
 * @remarks Called by `finalize()` on every run-end path (completed, failed, or
 *   cancelled) against ALL of `record.edges` — not just the manager's. It used to
 *   be pure defense-in-depth, on the argument that `runDispatch`'s
 *   `finally { await Promise.allSettled(deferred) }` could not let an iteration —
 *   and therefore the run — finish while a `run_leader` call from that iteration
 *   was still unsettled. **That argument no longer holds.** `run_leader` is
 *   background-only: it answers with a handle and its task moves to the
 *   supervision registry, so no dispatch awaits it and a leader can outlive the
 *   iteration that started it. What closes the gap instead is the pair that
 *   replaced the join — the finish gate refuses a terminal result while children
 *   are live, and the registry's teardown is awaited — after which
 *   `workflow_run_completed`/`workflow_run_failed` is still recorded
 *   synchronously (`TraceHandle.record` calls `onRecord` inline). So the ordinary
 *   `observe()` path still closes every started leader's edge before `finalize()`
 *   runs, but by a longer and more breakable chain than before; this function is
 *   now the backstop for that chain rather than for a hypothetical one. It does
 *   NOT help after a hard process crash — `finalize()` never runs on a crash, so
 *   a record left `"running"` by a crash is repaired by a different mechanism
 *   entirely.
 *
 *   That mechanism is lazy, not a restart sweep, and it is worth naming because
 *   "no reconciliation pass on restart" reads as "the record stays orphaned",
 *   which it does not. The chain is: the kernel recovers interrupted runs at
 *   boot (`recoverInterruptedRuns` → `TraceStore.recoverOrphans`), which folds
 *   each crashed run's journal into a persisted record with a terminal
 *   `"interrupted"` status and an `ended_at`; a persisted record is what
 *   `getById` can see, so from then on the next `get` or `list` touching the
 *   workflow finds terminal evidence and {@link reconcileRunningWorkflowRecord}
 *   repairs it to `failed` and saves it. A record nobody reads stays `"running"`
 *   on disk, and costs nothing, because `get` and `list` are its only consumers.
 *
 *   The residual is the case where that evidence never appears: the run's
 *   journal could not be opened at all, or recovery quarantined it as corrupt or
 *   refused it as oversized, or the boot budget was exhausted before reaching
 *   it. Then no persisted record exists, `getById` keeps answering `null`, and
 *   the workflow stays `"running"` for good. An eager restart sweep over the
 *   workflow store would not fix that either — it would be reading the same
 *   absent evidence — so what is genuinely unbuilt is a repair that does not
 *   depend on the trace, and no such source of truth exists today.
 */
export function closeRunningEdges(edges: WorkflowEdge[], status: RunStatus, endedAt: number): void {
  for (const edge of edges) {
    if (edge.status !== "running") continue;
    edge.status = status;
    edge.ended_at = endedAt;
  }
}

/** One leader's running tallies, plus the ids of every sub-agent it has
 * delegated to (announced by that sub-agent's `delegation_created` event).
 * Exported for direct unit testing. */
export interface LeaderProgress {
  iterations: number;
  input: number;
  output: number;
  delegatedIds: Set<string>;
}

/** A zeroed {@link LeaderProgress} for a leader seen for the first time.
 * Exported for direct unit testing. */
export function freshLeaderProgress(): LeaderProgress {
  return { iterations: 0, input: 0, output: 0, delegatedIds: new Set() };
}

/**
 * Whether an `iteration_completed` from a leader run is the leader's own turn,
 * rather than one belonging to a sub-agent it delegated to.
 *
 * @param event - the mapped iteration event.
 * @param acc - that leader's tallies; `delegatedIds` is populated from
 *   `delegation_created` events, each of which is recorded before the child it
 *   announces can emit any `subagent_iteration*` event of its own.
 * @returns true when the turn belongs to the leader itself.
 * @remarks A leader is whichever profile the manager named, and a *sub-agent
 *   role* profile (`explorer`, `coder`, …) runs its leader in
 *   `subagent-only` mode, so its turns arrive tagged `agent: "subagent"`.
 *   Counting only `agent === "lead"` therefore left every such leader reporting
 *   zero iterations forever — which the UI renders as a permanent "loading…"
 *   beside a leader that is in fact working, while its token totals climb. A
 *   leader can *also* delegate in normal `"lead"` mode, and its delegated
 *   child's own `subagent_iteration` can arrive before the leader's first
 *   `lead_iteration` — so "first `subagent_id` seen" is not a safe way to spot
 *   the entry agent. Checking `delegatedIds` instead is order-independent: a
 *   `subagent`-tagged turn belongs to the entry iff its id was never announced
 *   by a `delegation_created`.
 */
export function isLeaderEntryIteration(
  event: { agent?: string; subagent_id?: string },
  acc: LeaderProgress,
): boolean {
  if (event.agent === "lead") return true;
  const id = event.subagent_id;
  return id !== undefined && !acc.delegatedIds.has(id);
}

/**
 * Raise the manager's live-children ceiling to what its leader concurrency needs.
 *
 * @param body - the assembled manager request, mutated in place.
 * @param maxConcurrency - the tree-wide leader concurrency this manager runs under.
 * @remarks Two independent bounds decide how wide a fan-out actually gets: the
 * workflow semaphore, which admits `max_concurrency` leaders at once, and the
 * supervision registry, which refuses to register a child past
 * `agents.max_live_children`. A leader holds a registry slot for as long as it
 * runs, so leaving the second at its supervision default silently caps the first
 * — raising `max_concurrency` alone buys nothing but a longer queue. The floor is
 * applied rather than assigned: an operator who deliberately raised the
 * supervision ceiling keeps their value.
 */
function raiseLiveChildrenCeiling(body: RunRequestBody, maxConcurrency: number): void {
  const floor = managerLiveChildrenFloor(maxConcurrency);
  const existing = body.agents;
  const block: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const configured = block.max_live_children;
  block.max_live_children =
    typeof configured === "number" && Number.isInteger(configured) && configured > floor
      ? configured
      : floor;
  body.agents = block;
}

/** Remove the `workflow` grant from every profile so a leader can never become a
 * manager (defense-in-depth beyond not injecting the capability into leaders). */
function stripWorkflowGrant(body: RunRequestBody): void {
  if (!Array.isArray(body.profiles)) return;
  for (const profile of body.profiles) {
    if (Array.isArray(profile.grants)) {
      const retained: string[] = [];
      for (const grant of profile.grants) {
        if (grant !== "workflow") retained.push(grant);
      }
      profile.grants = retained;
    }
  }
}

/** Collapse an engine/edge status string onto a protocol {@link RunStatus}. */
function statusOf(raw: string): RunStatus {
  if (raw === "completed") return "completed";
  if (raw === "cancelled") return "cancelled";
  if (raw === "running") return "running";
  return "failed";
}

/** Stable title shown until the parallel metadata call returns. */
function provisionalWorkflowTitle(executionId: string): string {
  const token = executionId.startsWith("exec_") ? executionId.slice(5) : executionId;
  return `Workflow ${token.slice(0, 8) || "run"}`;
}

/** Project a persisted edge to a protocol {@link WorkflowNode}. */
function edgeToNode(edge: WorkflowEdge): WorkflowNode {
  return {
    run_id: edge.run_id,
    ...(edge.parent_run_id !== undefined ? { parent_run_id: edge.parent_run_id } : {}),
    kind: edge.kind,
    ...(edge.profile !== undefined ? { profile: edge.profile } : {}),
    title: edge.title,
    ...(edge.task !== undefined ? { task: edge.task } : {}),
    ...(edge.round_id !== undefined ? { round_id: edge.round_id } : {}),
    ...(edge.pass !== undefined ? { pass: edge.pass } : {}),
    ...(edge.item_index !== undefined ? { item_index: edge.item_index } : {}),
    ...(edge.replica !== undefined ? { replica: edge.replica } : {}),
    ...(edge.replica_count !== undefined ? { replica_count: edge.replica_count } : {}),
    ...(edge.error !== undefined ? { error: edge.error } : {}),
    ...(edge.reason !== undefined ? { reason: edge.reason } : {}),
    status: statusOf(edge.status),
    ...(edge.started_at !== undefined ? { started_at: edge.started_at } : {}),
    ...(edge.ended_at !== undefined ? { ended_at: edge.ended_at } : {}),
  };
}

/** Project a persisted record to a protocol {@link WorkflowSummary}. */
function recordToSummary(record: WorkflowRecord): WorkflowSummary {
  return {
    execution_id: record.id,
    status: statusOf(record.status),
    title: record.title,
    workspace: record.workspace,
    created_at: record.created_at,
    updated_at: record.updated_at,
    leader_count: record.edges.filter((edge) => edge.kind === "leader").length,
  };
}

/** Project the bounded sidecar directly without opening the workflow body. */
function storedSummaryToSummary(summary: WorkflowRecordSummary): WorkflowSummary {
  return {
    execution_id: summary.id,
    status: statusOf(summary.status),
    title: summary.title,
    workspace: summary.workspace,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    leader_count: summary.leader_count,
  };
}

/** Project a persisted record to a protocol {@link WorkflowDetail} (summary + nodes). */
function recordToDetail(record: WorkflowRecord): WorkflowDetail {
  return {
    ...recordToSummary(record),
    nodes: record.edges.map(edgeToNode),
    ...(record.sequence === undefined
      ? {}
      : { sequence: record.sequence satisfies WorkflowSequence }),
  };
}
