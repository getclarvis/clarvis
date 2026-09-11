import { boundPromise } from "@clarvis/loop/host";
import {
  bestEffort,
  NOOP_LOGGER,
  sanitizeErrorMessage,
  suppressSecondaryRejection,
  type Logger,
} from "@clarvis/capability";
import type {
  HostedHandoffFailureDetails,
  HostedRecoveryResolution,
  HostedExecutionConfig,
  HostedRunAttachment,
  HostedRunReceipt,
  HostedRunRef,
  HostingService,
  RunHandle,
  RunResult,
  StartHostedTurnParams,
} from "@clarvis/protocol";
import { kernelError, toKernelError } from "../core/errors.ts";
import { createGuardSessionAllowlist, type GuardSessionAllowlist } from "../guard/guard-elicit.ts";
import {
  createHostedAdmission,
  type HostedAdmissionOptions,
  type HostedContinuationAuthority,
  type HostedConversationAuthority,
  type HostedOccupancy,
  type HostingPeer,
} from "./admission.ts";
import { createHostedExecution, type HostedExecution } from "./execution.ts";
import type { HostedProjection } from "./projection.ts";
import { decodeHostedRegistryState, MAX_HOST_INDEX_BYTES } from "./state.ts";

/** Prepared configuration and a commit boundary retained even when writing the turn intent fails. */
export interface PreparedHostedTurn {
  title: string;
  config: HostedExecutionConfig;
  detachable: boolean;
  commitIntent(): Promise<void>;
  start(): Promise<RunHandle>;
  reconcile(result: RunResult): Promise<void>;
  /** Host policy for another bounded stage; never serialized or selected by public run arguments. */
  continuation?: HostedTurnContinuation;
}

/** Evaluated once after successful physical/durable settlement, under revocable controller authority. */
export interface HostedTurnContinuation {
  prepare(signal: AbortSignal): Promise<StartHostedTurnParams | undefined>;
  /** Persist policy attention after revocation or failure; must preserve a newer user/run decision. */
  stopped(reason: "revoked" | "superseded" | "failed"): Promise<void>;
}

/** Private host index; no prompts, provider credentials or volatile consent scopes enter it. */
export interface HostedRegistryState {
  schema_version: 1;
  host_generation: string;
  runs: Array<{ run: HostedRunRef; acknowledged: boolean }>;
  receipts: Array<{ receipt: HostedRunReceipt; expires_at: number }>;
}

/** Host-owned collaborators. A durable commit must complete before a detach receipt is returned. */
export interface HostedRegistryOptions {
  workspaceId: string;
  hostGeneration: string;
  /** Internal workspace-scoped run owner; the local process resolves it from the authenticated owner. */
  owner: string;
  prepare(
    input: StartHostedTurnParams,
    authority: {
      scope: string;
      signal: AbortSignal;
      continuationOf?: string;
      conversation?: HostedConversationAuthority;
    },
  ): Promise<PreparedHostedTurn>;
  projection(executionId: string): Promise<HostedProjection>;
  /** Remove only the acknowledged run's private observation artifact, never canonical history. */
  removeProjection(executionId: string, generation: string): Promise<void>;
  commit(state: HostedRegistryState): Promise<void>;
  /** Durably archive the canonical session before releasing old-generation physical uncertainty. */
  archiveRecovery?(
    run: HostedRunRef,
    resolution: HostedRecoveryResolution,
  ): Promise<HostedRecoveryResolution>;
  /** Prior process index. Only discovery metadata returns; no execution or consent is restored. */
  initialState?: HostedRegistryState;
  retireConfigurationSession(scope: string): void;
  limits?: Omit<HostedAdmissionOptions, "revokeInteractiveScope">;
  maxRetainedRuns?: number;
  maxReceipts?: number;
  receiptLifetimeMs?: number;
  /** Bound read-only continuation preparation and its failure notification; defaults to five seconds. */
  continuationTimeoutMs?: number;
  now?: () => number;
  logger?: Logger;
  /** Process-owned maintenance/lease admission also applies to internal automatic starts. */
  assertStartAllowed?(): void;
  /** Display invalidation when observation becomes available or physical occupancy is released. */
  executionChanged?(sessionId: string): void;
}

/** One authenticated connection's service scope; closing it does not close the kernel. */
export interface HostedRegistryConnection {
  readonly peer: HostingPeer;
  readonly service: HostingService;
  close(): Promise<void>;
}

/** Shared authority over all connections to one workspace/owner generation. */
export interface HostedRegistry {
  connect(role: HostingPeer["role"]): HostedRegistryConnection;
  guardAllowlistFor(run: { executionId: string; owner: string }): GuardSessionAllowlist | undefined;
  occupied(sessionId: string): boolean;
  /** Synchronous authority check for process-owned interactive callbacks, never a client claim. */
  controlsConversation(peerId: string, sessionId: string): boolean;
  /** Internal controls resolve an already authenticated connection, never fabricate a public peer. */
  claimController(peerId: string, sessionId: string): HostedConversationAuthority;
  assertOperator(peerId: string): void;
  assertController(authority: HostedConversationAuthority): void;
  startControlled(
    authority: HostedConversationAuthority,
    input: StartHostedTurnParams,
  ): Promise<HostedRunRef>;
  cancelControlled(authority: HostedConversationAuthority, executionId: string): Promise<void>;
  physicalRun(sessionId: string): HostedRunRef | undefined;
  hasPendingContinuation(): boolean;
  /** Permit pending-observation saves only for the connection holding that local activity. */
  ownsActivity(peerId: string, sessionId: string): boolean;
  /** Publish the current index before a process exposes its discovery credential. */
  sync(): Promise<void>;
  stats(): {
    connections: number;
    runs: number;
    activities: number;
    retained: number;
    receipts: number;
    committing: number;
    unresolved: number;
  };
  /** Called by the owning process, never by an individual TUI disconnect. */
  close(): Promise<void>;
}

interface Entry {
  ref: HostedRunRef;
  occupancy?: HostedOccupancy;
  prepared?: PreparedHostedTurn;
  projection?: HostedProjection;
  execution?: HostedExecution;
  source?: RunHandle;
  preparation: AbortController;
  acknowledged: boolean;
  stopRequested: boolean;
  preparationSettled: PromiseWithResolvers<void>;
  pruning?: Promise<void>;
  recovery?: Promise<HostedRunRef>;
  handoff?: { id: string; promise: Promise<HostedRunReceipt> };
  continuationAuthority?: HostedContinuationAuthority;
  continuation?: Promise<void>;
  continuationStop?: Promise<void>;
  retireContinuationListener?: () => void;
}

interface ConnectionState {
  peer: HostingPeer;
  observations: Map<string, { entry: Entry; epoch: number }>;
  snapshots: Map<string, { entry: Entry; observationId: string }>;
  activities: Map<string, HostedOccupancy>;
  observing: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function identifier(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  ) {
    throw kernelError(
      "invalid_request",
      `${name} must be a nonempty identifier of at most 256 characters`,
    );
  }
}

/**
 * Reserve conversation ownership before preparation, then retain each root independently of peers.
 * Handoff ids survive transport request loss; an expired receipt never permits mutation replay.
 * Acknowledgement hides a terminal startup offer, while canonical run/session history stays intact.
 */
export function createHostedRegistry(options: HostedRegistryOptions): HostedRegistry {
  const logger = options.logger ?? NOOP_LOGGER;
  const executionChanged = (sessionId: string): void => {
    try {
      options.executionChanged?.(sessionId);
    } catch {
      logger.warn(
        { event: "hosting.change.delivery_failed", session_id: sessionId },
        "Hosted execution observer failed",
      );
    }
  };
  const now = options.now ?? Date.now;
  const maxRetained = positive(options.maxRetainedRuns ?? 32, "maxRetainedRuns");
  const maxReceipts = positive(options.maxReceipts ?? 128, "maxReceipts");
  const receiptLifetime = positive(
    options.receiptLifetimeMs ?? 24 * 60 * 60 * 1000,
    "receiptLifetimeMs",
  );
  const continuationTimeout = positive(
    options.continuationTimeoutMs ?? 5000,
    "continuationTimeoutMs",
  );
  const entries = new Map<string, Entry>();
  const connections = new Map<string, ConnectionState>();
  const allowlists = new Map<string, GuardSessionAllowlist>();
  const receipts = new Map<string, { receipt: HostedRunReceipt; expires_at: number }>();
  const seenOperations = new Set<string>();
  const admission = createHostedAdmission({
    ...options.limits,
    revokeInteractiveScope(scope) {
      allowlists.get(scope)?.revoke();
      allowlists.delete(scope);
      options.retireConfigurationSession(scope);
    },
  });
  let closing = false;
  let writes = 0;
  let commitTail: Promise<void> = Promise.resolve();
  const unresolvedSessions = new Set<string>();
  if (options.initialState !== undefined) {
    const initial = decodeHostedRegistryState(options.initialState, {
      runs: maxRetained,
      receipts: maxReceipts,
    });
    if (initial.host_generation === options.hostGeneration)
      throw kernelError("conflict", "a restarted host requires a fresh generation");
    const recover = (previous: HostedRunRef): HostedRunRef => {
      if (
        previous.workspace_id !== options.workspaceId ||
        previous.host_generation === options.hostGeneration
      )
        throw kernelError("conflict", "host state belongs to another workspace or generation");
      const recovered = structuredClone(previous);
      recovered.control = "available";
      recovered.control_epoch++;
      recovered.revision++;
      recovered.attention = "none";
      if (recovered.execution_state !== "closed") {
        recovered.execution_state = "unknown";
        recovered.recovery_error = "Previous host ended; execution and teardown cannot be resumed.";
      }
      return recovered;
    };
    for (const item of initial.runs) {
      const ref = recover(item.run);
      const preparationSettled = Promise.withResolvers<void>();
      preparationSettled.resolve();
      entries.set(ref.execution_id, {
        ref,
        acknowledged: item.acknowledged,
        preparation: new AbortController(),
        preparationSettled,
        stopRequested: true,
      });
      if (ref.execution_state === "unknown") unresolvedSessions.add(ref.session_id);
    }
    for (const item of initial.receipts) {
      seenOperations.add(item.receipt.operation_id);
      const recovered = { ...item, receipt: { ...item.receipt, run: recover(item.receipt.run) } };
      if (item.expires_at > now()) receipts.set(item.receipt.operation_id, recovered);
    }
  }

  const touch = (entry: Entry): void => {
    entry.ref.revision++;
    entry.ref.updated_at = now();
    const state = entry.execution?.state();
    if (state === undefined) return;
    entry.ref.attention = state.attention;
    entry.ref.execution_state = state.terminalCommitted
      ? "closed"
      : state.result === undefined
        ? "running"
        : "finishing";
    if (state.recoveryError !== undefined) {
      entry.ref.recovery_error = "Hosted observation or conversation reconciliation failed.";
      entry.ref.execution_state = "unknown";
    }
    if (state.result !== undefined) {
      const { status, ended_reason, error, usage } = state.result;
      entry.ref.outcome = { status, ended_reason, error, usage };
    }
  };

  const view = (entry: Entry, peer?: HostingPeer): HostedRunRef => {
    const control = entry.occupancy === undefined ? undefined : admission.control(entry.occupancy);
    return structuredClone({
      ...entry.ref,
      control_epoch: control?.epoch ?? entry.ref.control_epoch,
      control:
        control?.peerId === undefined
          ? "available"
          : control.peerId === peer?.id
            ? "self"
            : "other",
    });
  };

  const receiptView = (receipt: HostedRunReceipt, peer?: HostingPeer): HostedRunReceipt => {
    const entry = entries.get(receipt.run.execution_id);
    return structuredClone({
      ...receipt,
      run: entry === undefined ? receipt.run : view(entry, peer),
    });
  };

  const persist = (change?: {
    run?: HostedRunRef;
    receipt?: HostedRunReceipt;
    terminalExecutionId?: string;
  }): Promise<void> => {
    if (writes >= 16)
      return Promise.reject(kernelError("resource_exhausted", "host state commit queue exhausted"));
    writes++;
    const result = commitTail
      .then(async () => {
        const state: HostedRegistryState = {
          schema_version: 1,
          host_generation: options.hostGeneration,
          runs: [...entries.values()].map((entry) => {
            const current = view(entry);
            const proposed =
              change?.run?.execution_id === entry.ref.execution_id ? change.run : current;
            return {
              run: {
                ...proposed,
                execution_state:
                  change?.terminalExecutionId === entry.ref.execution_id
                    ? ("closed" as const)
                    : current.execution_state,
                attention: current.attention,
                outcome: current.outcome,
                recovery_error: current.recovery_error,
              },
              acknowledged: entry.acknowledged,
            };
          }),
          receipts: [...receipts.values()]
            .filter((item) => item.expires_at > now())
            .map((item) => ({ ...item, receipt: receiptView(item.receipt) })),
        };
        if (change?.receipt !== undefined)
          state.receipts.push({ receipt: change.receipt, expires_at: now() + receiptLifetime });
        if (Buffer.byteLength(JSON.stringify(state)) > MAX_HOST_INDEX_BYTES)
          throw kernelError("resource_exhausted", "host state index exceeds 2 MiB");
        await options.commit(structuredClone(state));
      })
      .finally(() => {
        writes--;
      });
    commitTail = bestEffort(() => result, { operation: "hosting.state.commit", logger });
    return result;
  };

  const assertConnection = (connection: ConnectionState, operator = false): void => {
    if (
      closing ||
      connections.get(connection.peer.id) !== connection ||
      (operator && connection.peer.role !== "operator")
    ) {
      throw kernelError(
        "unauthorized",
        "local interactive connection has retired or lacks control authority",
      );
    }
  };
  const find = (id: string, generation = options.hostGeneration): Entry => {
    if (generation !== options.hostGeneration)
      throw kernelError("conflict", "host generation changed; reconcile its execution state");
    const entry = entries.get(id);
    if (entry === undefined || entry.pruning !== undefined)
      throw kernelError("not_found", "hosted execution is not retained by this host");
    if (entry.ref.host_generation !== generation)
      throw kernelError("conflict", "execution belongs to an ended host; open its history");
    return entry;
  };
  const assertControl = (connection: ConnectionState, entry: Entry, epoch: number): void => {
    assertConnection(connection, true);
    if (entry.occupancy === undefined)
      throw kernelError("not_found", "run no longer owns physical work");
    admission.assertControl(connection.peer, entry.occupancy, epoch);
  };
  const cancelAfterDisconnect = async (entry: Entry): Promise<void> => {
    await bestEffort(() => entry.handoff?.promise, {
      operation: "hosting.handoff.reconcile",
      logger,
    });
    if (entry.ref.disconnect_policy === "continue") return;
    entry.stopRequested = true;
    entry.preparation.abort();
    await entry.source?.cancel();
  };

  const prune = async (entry: Entry): Promise<void> => {
    if (entry.pruning !== undefined) return entry.pruning;
    if (
      !entry.acknowledged ||
      entry.occupancy !== undefined ||
      entry.continuationAuthority !== undefined ||
      entry.ref.execution_state !== "closed"
    )
      return;
    if (
      [...connections.values()].some((connection) =>
        [...connection.observations.values()].some((observation) => observation.entry === entry),
      )
    )
      return;
    const pruning = (async () => {
      if (entry.execution !== undefined) await entry.execution.dispose();
      else await entry.projection?.close();
      await options.removeProjection(entry.ref.execution_id, entry.ref.host_generation);
      for (const item of receipts.values()) {
        if (item.receipt.run.execution_id === entry.ref.execution_id)
          item.receipt = receiptView(item.receipt);
      }
      entries.delete(entry.ref.execution_id);
      await persist();
    })();
    entry.pruning = pruning;
    try {
      await pruning;
    } finally {
      delete entry.pruning;
    }
  };

  const observe = async (
    connection: ConnectionState,
    entry: Entry,
    control: "observe" | "acquire" | "takeover",
  ): Promise<HostedRunAttachment> => {
    if (control !== "observe" && control !== "acquire" && control !== "takeover")
      throw kernelError("invalid_request", "unknown attachment control mode");
    assertConnection(connection, control !== "observe");
    if (entry.handoff !== undefined)
      throw kernelError("conflict", "handoff is committing; reconcile its receipt first");
    if (entry.execution === undefined || entry.source === undefined)
      throw kernelError("conflict", "run is still preparing");
    if (connection.observations.size + connection.observing >= 4)
      throw kernelError("resource_exhausted", "connection observation limit reached");
    const observation = { entry, epoch: -1 };
    const source = entry.source;
    connection.observing++;
    let attachment: Awaited<ReturnType<HostedExecution["observe"]>> | undefined;
    try {
      attachment = await entry.execution.observe({
        async steer(message) {
          assertControl(connection, entry, observation.epoch);
          await source.steer(message);
        },
        async compact(request) {
          assertControl(connection, entry, observation.epoch);
          await source.compact(request);
        },
        async cancel() {
          assertControl(connection, entry, observation.epoch);
          await source.cancel();
        },
        async respond(response) {
          assertControl(connection, entry, observation.epoch);
          await source.respond(response);
        },
      });
      assertConnection(connection, control !== "observe");
      if (entry.handoff !== undefined)
        throw kernelError("conflict", "handoff began during observation preparation");
      if (control !== "observe" && entry.occupancy !== undefined) {
        observation.epoch = admission.acquire(
          connection.peer,
          entry.occupancy,
          control === "takeover",
        ).epoch;
        touch(entry);
      } else if (control !== "observe" && admission.hasConversation(entry.ref.session_id)) {
        admission.claimConversation(connection.peer, entry.ref.session_id, control === "takeover");
      }
      connection.observations.set(attachment.observation_id, observation);
      connection.snapshots.set(attachment.snapshot.snapshot_id, {
        entry,
        observationId: attachment.observation_id,
      });
      return { ...attachment, run: view(entry, connection.peer) };
    } catch (error) {
      if (attachment !== undefined) entry.execution.releaseObservation(attachment.observation_id);
      throw error;
    } finally {
      connection.observing--;
    }
  };

  const closeConnection = async (connection: ConnectionState): Promise<void> => {
    if (connections.get(connection.peer.id) !== connection) return;
    const owned = [...entries.values()].filter(
      (entry) =>
        entry.occupancy !== undefined &&
        admission.control(entry.occupancy).peerId === connection.peer.id,
    );
    connections.delete(connection.peer.id);
    try {
      admission.disconnect(connection.peer);
    } catch {
      logger.warn(
        { event: "hosting.consent.retirement_failed" },
        "interactive consent cleanup failed after control retirement",
      );
    }
    for (const [id, observation] of connection.observations)
      observation.entry.execution?.releaseObservation(id);
    connection.observations.clear();
    connection.snapshots.clear();
    await Promise.all(
      owned.map(async (entry) => {
        try {
          await cancelAfterDisconnect(entry);
        } catch {
          logger.warn(
            { event: "hosting.execution.cancel_failed", execution_id: entry.ref.execution_id },
            "disconnected run did not acknowledge cancellation",
          );
        }
      }),
    );
    await Promise.all([...entries.values()].map(prune));
  };

  const stopContinuation = (
    entry: Entry,
    reason: "revoked" | "superseded" | "failed",
  ): Promise<void> => {
    const policy = entry.prepared?.continuation;
    if (policy === undefined) return Promise.resolve();
    entry.continuationStop ??= (async () => {
      try {
        await boundPromise(() => policy.stopped(reason), {
          timeoutMs: continuationTimeout,
          onTimeout: () => {
            throw kernelError("unavailable", "Continuation attention could not be persisted");
          },
          onAbort: () => undefined,
        });
      } catch {
        logger.warn(
          { event: "hosting.continuation.attention_failed", execution_id: entry.ref.execution_id },
          "Continuation stopped but its policy attention could not be persisted",
        );
      }
    })();
    return entry.continuationStop;
  };

  const continueEntry = async (connection: ConnectionState, entry: Entry): Promise<void> => {
    const policy = entry.prepared?.continuation;
    const authority = entry.continuationAuthority;
    if (policy === undefined || authority === undefined) return;
    const stopped = (reason: "revoked" | "superseded" | "failed") =>
      stopContinuation(entry, reason);
    const revoked = () =>
      stopped(authority.signal.reason === "superseded" ? "superseded" : "revoked");
    try {
      const state = entry.execution?.state();
      if (state?.terminalCommitted !== true) {
        await stopped("failed");
        return;
      }
      if (state.result?.status !== "completed" || state.result.disposition !== "checkpoint") return;
      if (authority.signal.aborted) {
        await revoked();
        return;
      }
      const input = await boundPromise(() => policy.prepare(authority.signal), {
        signal: authority.signal,
        timeoutMs: continuationTimeout,
        onTimeout: () => {
          throw kernelError("unavailable", "Continuation preparation exceeded its deadline");
        },
        onAbort: () => undefined,
      });
      if (authority.signal.aborted) {
        await revoked();
        return;
      }
      if (input === undefined) return;
      if (
        input.session_id !== authority.sessionId ||
        input.kind !== "conversation" ||
        input.params.continue_from !== authority.executionId
      )
        throw kernelError(
          "invalid_request",
          "Continuation must preserve its conversation and predecessor",
        );
      await startEntry(connection, input, authority);
    } catch {
      logger.warn(
        { event: "hosting.continuation.failed", execution_id: entry.ref.execution_id },
        "Automatic continuation was refused or could not be prepared",
      );
      await stopped("failed");
    } finally {
      entry.retireContinuationListener?.();
      delete entry.retireContinuationListener;
      admission.retireContinuation(authority);
      delete entry.continuationAuthority;
      await entry.continuationStop;
      await bestEffort(() => prune(entry), { operation: "hosting.continuation.prune", logger });
    }
  };

  const startEntry = async (
    connection: ConnectionState,
    input: StartHostedTurnParams,
    continuation?: HostedContinuationAuthority,
  ): Promise<Entry> => {
    assertConnection(connection, true);
    options.assertStartAllowed?.();
    const peer = connection.peer;
    if (unresolvedSessions.has(input.session_id))
      throw kernelError("conflict", "conversation has unresolved work from a previous host");
    if (
      typeof input.user_preview !== "string" ||
      input.user_preview.length > 4096 ||
      (input.kind !== "conversation" && input.kind !== "transcript") ||
      !Number.isSafeInteger(input.session_revision) ||
      input.session_revision < 0
    ) {
      throw kernelError("invalid_request", "invalid hosted turn preview, kind or session revision");
    }
    identifier(input.params.execution_id, "execution id");
    if (entries.has(input.params.execution_id))
      throw kernelError(
        "conflict",
        "execution id is already registered; attach instead of starting it again",
      );
    if (entries.size >= maxRetained)
      throw kernelError("resource_exhausted", "hosted run retention limit reached");
    const occupancy =
      continuation === undefined
        ? admission.reserve(peer, input.session_id, "run", input.params.execution_id)
        : admission.reserveContinuation(continuation, input.params.execution_id);
    const entry: Entry = {
      occupancy,
      preparation: new AbortController(),
      acknowledged: false,
      stopRequested: false,
      preparationSettled: Promise.withResolvers<void>(),
      ref: {
        execution_id: input.params.execution_id,
        session_id: input.session_id,
        workspace_id: options.workspaceId,
        host_generation: options.hostGeneration,
        title: input.user_preview.slice(0, 256),
        config: { agent: input.params.agent ?? input.params.skill?.name ?? "default" },
        created_at: now(),
        updated_at: now(),
        revision: 1,
        disconnect_policy: "cancel",
        execution_state: "starting",
        attention: "none",
        control_epoch: 1,
        control: "self",
      },
    };
    entries.set(input.params.execution_id, entry);
    try {
      const control = admission.control(occupancy);
      entry.projection = await options.projection(input.params.execution_id);
      assertControl(connection, entry, control.epoch);
      entry.prepared = await options.prepare(input, {
        scope: control.interactiveScope!,
        signal: entry.preparation.signal,
        conversation: admission.conversation(peer, input.session_id),
        ...(continuation === undefined ? {} : { continuationOf: continuation.executionId }),
      });
      entry.ref.config = entry.prepared.config;
      entry.ref.title = entry.prepared.title.slice(0, 256);
      assertControl(connection, entry, control.epoch);
      if (entry.prepared.continuation !== undefined) {
        entry.continuationAuthority = admission.captureContinuation(peer, occupancy);
        const signal = entry.continuationAuthority.signal;
        const revoked = (): void => {
          if (signal.reason !== "superseded")
            suppressSecondaryRejection(
              stopContinuation(entry, "revoked"),
              "the bounded host continuation stop handler",
            );
        };
        signal.addEventListener("abort", revoked, { once: true });
        entry.retireContinuationListener = () => signal.removeEventListener("abort", revoked);
      }
      await entry.prepared.commitIntent();
      assertControl(connection, entry, control.epoch);
      await persist();
      assertControl(connection, entry, control.epoch);
      options.assertStartAllowed?.();
      entry.source = await entry.prepared.start();
      if (entry.source.execution_id !== entry.ref.execution_id)
        throw kernelError("internal", "hosted start returned a different execution identity");
      entry.execution = createHostedExecution({
        handle: entry.source,
        projection: entry.projection,
        logger,
        reconcile: (result) => entry.prepared!.reconcile(result),
        async commitTerminal() {
          try {
            await persist({ terminalExecutionId: entry.ref.execution_id });
            entry.ref.control_epoch = admission.control(occupancy).epoch;
            admission.release(occupancy);
            delete entry.occupancy;
            executionChanged(entry.ref.session_id);
          } catch {
            entry.ref.execution_state = "unknown";
            entry.ref.recovery_error = "Host could not commit the terminal run index.";
            throw kernelError("unavailable", entry.ref.recovery_error);
          }
        },
        changed: () => touch(entry),
      });
      touch(entry);
      executionChanged(entry.ref.session_id);
      void entry.execution.settled.catch(() => {
        entry.ref.execution_state = "unknown";
        entry.ref.recovery_error = "Hosted execution closure could not be observed.";
      });
      entry.continuation = entry.execution.settled.then(
        () => continueEntry(connection, entry),
        () => continueEntry(connection, entry),
      );
      if (entry.stopRequested) await entry.source.cancel();
      return entry;
    } catch (error) {
      entry.retireContinuationListener?.();
      delete entry.retireContinuationListener;
      if (entry.continuationAuthority !== undefined)
        admission.retireContinuation(entry.continuationAuthority);
      delete entry.continuationAuthority;
      if (entry.execution === undefined) {
        const reason = toKernelError(error);
        const failed: RunResult = {
          execution_id: entry.ref.execution_id,
          status: "failed",
          error: { code: reason.code, message: sanitizeErrorMessage(reason.message) },
        };
        try {
          if (entry.source !== undefined) {
            const source = entry.source;
            const drain = (async () => {
              for await (const _event of source.events) {
                /* Drain without retaining abandoned execution events. */
              }
            })();
            await Promise.all([source.cancel(), source.closed, source.done, drain]);
          }
          await entry.prepared?.reconcile(failed);
          await entry.projection?.close();
          entry.ref.execution_state = "closed";
          entry.ref.outcome = { status: failed.status, error: failed.error };
          await persist();
          admission.release(occupancy);
          delete entry.occupancy;
          executionChanged(entry.ref.session_id);
        } catch {
          entry.ref.execution_state = "unknown";
          entry.ref.recovery_error = "Hosted turn preparation could not be reconciled.";
        }
      }
      throw error;
    } finally {
      entry.preparationSettled.resolve();
    }
  };

  const connect = (role: HostingPeer["role"]): HostedRegistryConnection => {
    if (closing) throw kernelError("unavailable", "host is closing");
    const peer = admission.connect(role);
    const connection: ConnectionState = {
      peer,
      observations: new Map(),
      snapshots: new Map(),
      activities: new Map(),
      observing: 0,
    };
    connections.set(peer.id, connection);
    const service: HostingService = {
      async list() {
        assertConnection(connection);
        return [...entries.values()]
          .filter((entry) => !entry.acknowledged)
          .map((entry) => view(entry, peer));
      },
      async start(input) {
        const entry = await startEntry(connection, input);
        return observe(connection, entry, "acquire");
      },
      async attach(input) {
        identifier(input.host_generation, "host generation");
        return observe(connection, find(input.execution_id, input.host_generation), input.control);
      },
      async controlObservation(id, control) {
        assertConnection(connection, true);
        if (control !== "acquire" && control !== "takeover")
          throw kernelError("invalid_request", "unknown observation control mode");
        const observation = connection.observations.get(id);
        if (observation === undefined)
          throw kernelError("not_found", "observation does not belong to this connection");
        const { entry } = observation;
        if (entry.handoff !== undefined)
          throw kernelError("conflict", "handoff is committing; reconcile its receipt first");
        if (entry.occupancy === undefined || entry.execution === undefined)
          throw kernelError("conflict", "observation no longer has active execution");
        observation.epoch = admission.acquire(
          connection.peer,
          entry.occupancy,
          control === "takeover",
        ).epoch;
        touch(entry);
        return view(entry, connection.peer);
      },
      async detach(input) {
        let admitted = seenOperations.has(input.operation_id) || receipts.has(input.operation_id);
        try {
          assertConnection(connection, true);
          identifier(input.host_generation, "host generation");
          identifier(input.operation_id, "handoff operation id");
          const previous = receipts.get(input.operation_id);
          if (previous !== undefined && previous.expires_at > now()) {
            if (
              previous.receipt.run.execution_id !== input.execution_id ||
              previous.receipt.run.host_generation !== input.host_generation
            )
              throw kernelError("conflict", "handoff id belongs to a different execution");
            return receiptView(previous.receipt, peer);
          }
          const entry = find(input.execution_id, input.host_generation);
          if (entry.handoff?.id === input.operation_id)
            return await entry.handoff.promise.then((receipt) => receiptView(receipt, peer));
          if (seenOperations.has(input.operation_id))
            throw kernelError(
              "conflict",
              "handoff result is unknown or expired; mutation will not be replayed",
            );
          if (entry.handoff !== undefined)
            throw kernelError("conflict", "another handoff is committing");
          if (seenOperations.size >= maxReceipts)
            throw kernelError("resource_exhausted", "handoff receipt history is full");
          assertControl(connection, entry, input.control_epoch);
          if (entry.ref.revision !== input.revision)
            throw kernelError("conflict", "run revision changed; refresh before handoff");
          if (entry.execution === undefined || entry.prepared?.detachable !== true)
            throw kernelError("conflict", "preparing or native configuration runs cannot detach");
          if (entry.execution.state().recoveryError !== undefined)
            throw kernelError("unavailable", "hosted recovery is unavailable");
          seenOperations.add(input.operation_id);
          admitted = true;
          const promise = (async (): Promise<HostedRunReceipt> => {
            await entry.projection!.sync();
            const run: HostedRunRef = {
              ...view(entry),
              revision: entry.ref.revision + 1,
              disconnect_policy: "continue",
              control_epoch: input.control_epoch + 1,
              control: "available",
            };
            const receipt: HostedRunReceipt = {
              operation_id: input.operation_id,
              run,
              committed_at: now(),
            };
            await persist({ run, receipt });
            entry.ref.disconnect_policy = "continue";
            receipts.set(input.operation_id, { receipt, expires_at: now() + receiptLifetime });
            if (connections.get(peer.id) === connection) {
              try {
                admission.closeSession(peer, entry.ref.session_id);
              } catch {
                logger.warn(
                  { event: "hosting.consent.retirement_failed" },
                  "handoff committed after interactive control retirement",
                );
              }
            }
            touch(entry);
            return receipt;
          })();
          entry.handoff = { id: input.operation_id, promise };
          try {
            return receiptView(await promise, peer);
          } finally {
            delete entry.handoff;
          }
        } catch (error) {
          const failure = toKernelError(error);
          throw kernelError(failure.code, failure.message, {
            handoff: {
              operation_id: input.operation_id,
              admission: admitted ? "uncertain" : "refused",
            },
          } satisfies HostedHandoffFailureDetails);
        }
      },
      async receipt(id) {
        assertConnection(connection);
        const value = receipts.get(id);
        return value === undefined || value.expires_at <= now()
          ? null
          : receiptView(value.receipt, peer);
      },
      async readSnapshot(id, offset) {
        assertConnection(connection);
        const projection = connection.snapshots.get(id)?.entry.projection;
        if (projection === undefined)
          throw kernelError("not_found", "snapshot does not belong to this connection");
        return projection.readPage(id, offset);
      },
      async releaseSnapshot(id) {
        assertConnection(connection);
        connection.snapshots.get(id)?.entry.projection?.releaseSnapshot(id);
        connection.snapshots.delete(id);
      },
      async releaseObservation(id) {
        assertConnection(connection);
        const entry = connection.observations.get(id)?.entry;
        entry?.execution?.releaseObservation(id);
        connection.observations.delete(id);
        for (const [snapshotId, owner] of connection.snapshots) {
          if (owner.observationId === id) connection.snapshots.delete(snapshotId);
        }
        if (entry !== undefined) await prune(entry);
      },
      async closeSession(sessionId) {
        assertConnection(connection);
        const owned = [...entries.values()].filter(
          (entry) =>
            entry.ref.session_id === sessionId &&
            entry.occupancy !== undefined &&
            admission.control(entry.occupancy).peerId === peer.id,
        );
        admission.closeSession(peer, sessionId);
        await Promise.all(owned.map(cancelAfterDisconnect));
      },
      async resolveRecovery(input) {
        assertConnection(connection, true);
        if (
          typeof input !== "object" ||
          input === null ||
          Object.keys(input).some(
            (key) =>
              !["execution_id", "host_generation", "revision", "physical_work_stopped"].includes(
                key,
              ),
          ) ||
          typeof input.execution_id !== "string" ||
          typeof input.host_generation !== "string" ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < 0 ||
          input.physical_work_stopped !== true
        )
          throw kernelError(
            "invalid_request",
            "recovery requires explicit physical closure confirmation and an observed revision",
          );
        const entry = entries.get(input.execution_id);
        if (entry === undefined || entry.pruning !== undefined)
          throw kernelError("not_found", "hosted execution is not retained by this host");
        if (
          entry.ref.host_generation !== input.host_generation ||
          input.host_generation === options.hostGeneration
        )
          throw kernelError("conflict", "recovery must name an ended host generation");
        if (entry.ref.revision !== input.revision)
          throw kernelError("conflict", "recovery revision changed; refresh before confirming");
        if (
          entry.occupancy !== undefined ||
          entry.execution !== undefined ||
          entry.ref.execution_state !== "unknown"
        )
          throw kernelError("conflict", "only old unknown physical work can be resolved");
        if (entry.recovery !== undefined) return entry.recovery;
        const archive = options.archiveRecovery?.bind(options);
        if (archive === undefined)
          throw kernelError("unavailable", "durable recovery archive is unavailable");
        const recovery = (async (): Promise<HostedRunRef> => {
          const resolution = await archive(structuredClone(entry.ref), {
            kind: "operator_verified_physical_closure",
            previous_host_generation: entry.ref.host_generation,
            resolving_host_generation: options.hostGeneration,
            operator_connection_id: peer.id,
            resolved_at: now(),
          });
          const proposed: HostedRunRef = {
            ...entry.ref,
            execution_state: "closed",
            recovery_resolution: resolution,
            revision: entry.ref.revision + 1,
            updated_at: now(),
          };
          await persist({ run: proposed, terminalExecutionId: entry.ref.execution_id });
          entry.ref = proposed;
          if (
            ![...entries.values()].some(
              (other) =>
                other.ref.session_id === entry.ref.session_id &&
                other.ref.execution_state === "unknown",
            )
          )
            unresolvedSessions.delete(entry.ref.session_id);
          return view(entry, peer);
        })();
        entry.recovery = recovery;
        try {
          return await recovery;
        } finally {
          if (entry.recovery === recovery) delete entry.recovery;
        }
      },
      async acknowledge(id) {
        assertConnection(connection, true);
        const entry = entries.get(id);
        if (entry === undefined || entry.pruning !== undefined)
          throw kernelError("not_found", "hosted execution is not retained by this host");
        if (entry.occupancy !== undefined || entry.ref.execution_state !== "closed")
          throw kernelError("conflict", "run still owns physical or unreconciled work");
        entry.acknowledged = true;
        try {
          await persist();
        } catch (error) {
          entry.acknowledged = false;
          throw error;
        }
        await prune(entry);
      },
      async reserveActivity(sessionId, kind) {
        assertConnection(connection, true);
        if (unresolvedSessions.has(sessionId))
          throw kernelError("conflict", "conversation has unresolved work from a previous host");
        const occupancy = admission.reserve(peer, sessionId, kind);
        connection.activities.set(occupancy.id, occupancy);
        return {
          lease_id: occupancy.id,
          session_id: sessionId,
          host_generation: options.hostGeneration,
          kind,
        };
      },
      async releaseActivity(id) {
        assertConnection(connection, true);
        const occupancy = connection.activities.get(id);
        if (occupancy === undefined)
          throw kernelError("not_found", "local activity lease is not owned by this connection");
        admission.release(occupancy);
        connection.activities.delete(id);
      },
    };
    return { peer, service, close: () => closeConnection(connection) };
  };

  return {
    connect,
    assertOperator(peerId) {
      const connection = connections.get(peerId);
      if (connection === undefined)
        throw kernelError("unauthorized", "conversation controller disconnected");
      assertConnection(connection, true);
    },
    claimController(peerId, sessionId) {
      const connection = connections.get(peerId);
      if (connection === undefined)
        throw kernelError("unauthorized", "conversation controller disconnected");
      assertConnection(connection, true);
      return admission.claimConversation(connection.peer, sessionId);
    },
    assertController(authority) {
      if (closing) throw kernelError("unavailable", "host is closing");
      admission.assertConversation(authority);
    },
    async startControlled(authority, input) {
      admission.assertConversation(authority);
      if (input.session_id !== authority.sessionId)
        throw kernelError("unauthorized", "goal control belongs to another conversation");
      const connection = connections.get(authority.peerId);
      if (connection === undefined)
        throw kernelError("unauthorized", "conversation controller disconnected");
      return view(await startEntry(connection, input), connection.peer);
    },
    async cancelControlled(authority, executionId) {
      admission.assertConversation(authority);
      const entry = entries.get(executionId);
      if (entry?.ref.session_id !== authority.sessionId)
        throw kernelError("not_found", "bound execution is absent");
      if (entry.occupancy === undefined) return;
      entry.stopRequested = true;
      if (entry.source === undefined) entry.preparation.abort();
      else await entry.source.cancel();
    },
    physicalRun(sessionId) {
      const entry = [...entries.values()].find(
        (entry) =>
          entry.ref.session_id === sessionId &&
          (entry.occupancy !== undefined || entry.ref.execution_state === "unknown"),
      );
      return entry === undefined ? undefined : view(entry);
    },
    hasPendingContinuation: () =>
      [...entries.values()].some((entry) => entry.continuationAuthority !== undefined),
    sync: () => persist(),
    guardAllowlistFor({ owner, executionId }) {
      const entry = entries.get(executionId);
      if (owner !== options.owner || entry?.occupancy === undefined) return undefined;
      const scope = admission.control(entry.occupancy).interactiveScope;
      if (scope === undefined) return undefined;
      let allowlist = allowlists.get(scope);
      if (allowlist === undefined) {
        allowlist = createGuardSessionAllowlist();
        allowlists.set(scope, allowlist);
      }
      return allowlist;
    },
    occupied: (sessionId) => unresolvedSessions.has(sessionId) || admission.occupied(sessionId),
    controlsConversation: (peerId, sessionId) =>
      connections.has(peerId) &&
      [...entries.values()].some(
        (entry) =>
          entry.ref.session_id === sessionId &&
          entry.occupancy !== undefined &&
          admission.control(entry.occupancy).peerId === peerId,
      ),
    ownsActivity: (peerId, sessionId) =>
      [...(connections.get(peerId)?.activities.values() ?? [])].some(
        (occupancy) => occupancy.sessionId === sessionId,
      ),
    stats: () => ({
      ...admission.stats(),
      retained: entries.size,
      receipts: receipts.size,
      committing: writes,
      unresolved: unresolvedSessions.size,
    }),
    async close() {
      closing = true;
      await Promise.all([...connections.values()].map(closeConnection));
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          await bestEffort(() => entry.recovery, { operation: "hosting.recovery.settle", logger });
          entry.preparation.abort();
          await entry.preparationSettled.promise;
          await entry.source?.cancel();
          await entry.execution?.settled;
          await entry.continuation;
          await entry.continuationStop;
          if (entry.execution !== undefined) await entry.execution.dispose();
          else await entry.projection?.close();
        }),
      );
      await commitTail;
    },
  };
}
