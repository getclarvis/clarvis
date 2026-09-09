import { bestEffort, NOOP_LOGGER, sanitizeErrorMessage, type Logger } from "@clarvis/capability";
import type {
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
    authority: { scope: string; signal: AbortSignal },
  ): Promise<PreparedHostedTurn>;
  projection(executionId: string): Promise<HostedProjection>;
  /** Remove only the acknowledged run's private observation artifact, never canonical history. */
  removeProjection(executionId: string, generation: string): Promise<void>;
  commit(state: HostedRegistryState): Promise<void>;
  /** Prior process index. Only discovery metadata returns; no execution or consent is restored. */
  initialState?: HostedRegistryState;
  retireConfigurationSession(scope: string): void;
  limits?: Omit<HostedAdmissionOptions, "revokeInteractiveScope">;
  maxRetainedRuns?: number;
  maxReceipts?: number;
  receiptLifetimeMs?: number;
  now?: () => number;
  logger?: Logger;
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
  handoff?: { id: string; promise: Promise<HostedRunReceipt> };
}

interface ConnectionState {
  peer: HostingPeer;
  observations: Map<string, Entry>;
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
  const now = options.now ?? Date.now;
  const maxRetained = positive(options.maxRetainedRuns ?? 32, "maxRetainedRuns");
  const maxReceipts = positive(options.maxReceipts ?? 128, "maxReceipts");
  const receiptLifetime = positive(
    options.receiptLifetimeMs ?? 24 * 60 * 60 * 1000,
    "receiptLifetimeMs",
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
    entry.ref.execution_state =
      state.physicalClosed && state.reconciled
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

  const persist = (change?: { run?: HostedRunRef; receipt?: HostedRunReceipt }): Promise<void> => {
    if (writes >= 16)
      return Promise.reject(kernelError("resource_exhausted", "host state commit queue exhausted"));
    writes++;
    const result = commitTail
      .then(async () => {
        const state: HostedRegistryState = {
          schema_version: 1,
          host_generation: options.hostGeneration,
          runs: [...entries.values()].map((entry) => ({
            run: change?.run?.execution_id === entry.ref.execution_id ? change.run : view(entry),
            acknowledged: entry.acknowledged,
          })),
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
      entry.ref.execution_state !== "closed"
    )
      return;
    if (
      [...connections.values()].some((connection) =>
        [...connection.observations.values()].includes(entry),
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
    let epoch = -1;
    const source = entry.source;
    connection.observing++;
    let attachment: Awaited<ReturnType<HostedExecution["observe"]>> | undefined;
    try {
      attachment = await entry.execution.observe({
        async steer(message) {
          assertControl(connection, entry, epoch);
          await source.steer(message);
        },
        async compact(request) {
          assertControl(connection, entry, epoch);
          await source.compact(request);
        },
        async cancel() {
          assertControl(connection, entry, epoch);
          await source.cancel();
        },
        async respond(response) {
          assertControl(connection, entry, epoch);
          await source.respond(response);
        },
      });
      assertConnection(connection, control !== "observe");
      if (entry.handoff !== undefined)
        throw kernelError("conflict", "handoff began during observation preparation");
      if (control !== "observe" && entry.occupancy !== undefined) {
        epoch = admission.acquire(connection.peer, entry.occupancy, control === "takeover").epoch;
        touch(entry);
      }
      connection.observations.set(attachment.observation_id, entry);
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
    for (const [id, entry] of connection.observations) entry.execution?.releaseObservation(id);
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
        assertConnection(connection, true);
        if (unresolvedSessions.has(input.session_id))
          throw kernelError("conflict", "conversation has unresolved work from a previous host");
        if (
          typeof input.user_preview !== "string" ||
          input.user_preview.length > 4096 ||
          (input.kind !== "conversation" && input.kind !== "transcript") ||
          !Number.isSafeInteger(input.session_revision) ||
          input.session_revision < 0
        ) {
          throw kernelError(
            "invalid_request",
            "invalid hosted turn preview, kind or session revision",
          );
        }
        identifier(input.params.execution_id, "execution id");
        if (entries.has(input.params.execution_id))
          throw kernelError(
            "conflict",
            "execution id is already registered; attach instead of starting it again",
          );
        if (entries.size >= maxRetained)
          throw kernelError("resource_exhausted", "hosted run retention limit reached");
        const occupancy = admission.reserve(
          peer,
          input.session_id,
          "run",
          input.params.execution_id,
        );
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
          });
          entry.ref.config = entry.prepared.config;
          entry.ref.title = entry.prepared.title.slice(0, 256);
          assertControl(connection, entry, control.epoch);
          await entry.prepared.commitIntent();
          assertControl(connection, entry, control.epoch);
          await persist();
          assertControl(connection, entry, control.epoch);
          entry.source = await entry.prepared.start();
          if (entry.source.execution_id !== entry.ref.execution_id)
            throw kernelError("internal", "hosted start returned a different execution identity");
          entry.execution = createHostedExecution({
            handle: entry.source,
            projection: entry.projection,
            logger,
            reconcile: (result) => entry.prepared!.reconcile(result),
            changed: () => touch(entry),
          });
          touch(entry);
          void entry.execution.settled
            .then(async () => {
              try {
                await persist();
                const state = entry.execution!.state();
                if (state.physicalClosed && state.reconciled) {
                  entry.ref.control_epoch = admission.control(occupancy).epoch;
                  admission.release(occupancy);
                  delete entry.occupancy;
                }
              } catch {
                entry.ref.execution_state = "unknown";
                entry.ref.recovery_error = "Host could not commit the terminal run index.";
              }
            })
            .catch(() => {
              entry.ref.execution_state = "unknown";
              entry.ref.recovery_error = "Hosted execution closure could not be observed.";
            });
          if (entry.stopRequested) await entry.source.cancel();
          return await observe(connection, entry, "acquire");
        } catch (error) {
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
              admission.release(occupancy);
              delete entry.occupancy;
              await persist();
            } catch {
              entry.ref.execution_state = "unknown";
              entry.ref.recovery_error = "Hosted turn preparation could not be reconciled.";
            }
          }
          throw error;
        } finally {
          entry.preparationSettled.resolve();
        }
      },
      async attach(input) {
        identifier(input.host_generation, "host generation");
        return observe(connection, find(input.execution_id, input.host_generation), input.control);
      },
      async detach(input) {
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
          return entry.handoff.promise.then((receipt) => receiptView(receipt, peer));
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
        const entry = connection.observations.get(id);
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
          entry.preparation.abort();
          await entry.preparationSettled.promise;
          await entry.source?.cancel();
          await entry.execution?.settled;
          if (entry.execution !== undefined) await entry.execution.dispose();
          else await entry.projection?.close();
        }),
      );
      await commitTail;
    },
  };
}
