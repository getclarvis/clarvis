import { randomUUID } from "node:crypto";
import type { RunServiceConfig } from "../runs/run-service.ts";
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

/** One prepared automatic successor, with the earliest instant the host may start it. */
export interface HostedContinuationProposal {
  input: StartHostedTurnParams;
  /**
   * Earliest start instant, from a provider-requested backoff.
   *
   * @remarks Carried out of the short preparation deadline so the host owns the wait: it
   *   is abortable with the continuation authority and accounted, and the policy is asked
   *   again afterwards, rather than a proposal going stale inside a bounded read.
   */
  not_before?: number;
}

/** Evaluated once after successful physical/durable settlement, under revocable controller authority. */
export interface HostedTurnContinuation {
  prepare(signal: AbortSignal): Promise<HostedContinuationProposal | undefined>;
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
  /** Persist authenticated input before waiting for the previous physical execution. */
  acceptOperator?(input: StartHostedTurnParams): Promise<"pending" | "delivered">;
  deliverOperator?(sessionId: string, executionId: string, deliveredTo: string): Promise<void>;
  /** Re-read a pending submission and the canonical history under the existing session authority. */
  prepareOperator?(sessionId: string, executionId: string): Promise<StartHostedTurnParams>;
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
  /**
   * Release the resolved conversation's own physical uncertainty after the durable audit.
   *
   * @param run - the resolved execution's discovery row.
   * @remarks Called only for a `continue` resolution, after {@link archiveRecovery} committed the
   *   attestation. The registry owns the execution; the conversation's own bookkeeping — a Goal
   *   stage that never reported an ending, for instance — belongs to whoever owns that record, so
   *   the release is their transaction rather than something the registry infers.
   */
  continueRecovery?(run: HostedRunRef): Promise<void>;
  /** Prior process index. Only discovery metadata returns; no execution or consent is restored. */
  initialState?: HostedRegistryState;
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
  /** Live semantic-authority binding; retirement revokes its signal synchronously. */
  operatorAuthorityFor: NonNullable<RunServiceConfig["operatorAuthorityFor"]>;
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
  /** Reattach a healthy attempt or await its already requested closure before a successor. */
  resumePhysical(authority: HostedConversationAuthority): Promise<HostedRunRef | undefined>;
  execution(executionId: string): HostedRunRef | undefined;
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
  operatorInput?: boolean;
  input?: StartHostedTurnParams;
  steering?: Map<string, Promise<void>>;
  steeringDelivery?: Map<string, { promise: Promise<void>; resolve(): void }>;
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

/** Platform ceiling for one timer, so no accepted duration can be shortened silently. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  const authorityScopes = new Map<string, AbortController>();
  const receipts = new Map<string, { receipt: HostedRunReceipt; expires_at: number }>();
  const seenOperations = new Set<string>();
  const admission = createHostedAdmission({
    ...options.limits,
    revokeInteractiveScope(scope) {
      authorityScopes.get(scope)?.abort();
      authorityScopes.delete(scope);
      allowlists.get(scope)?.revoke();
      allowlists.delete(scope);
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
          if (
            options.acceptOperator === undefined ||
            options.deliverOperator === undefined ||
            entry.input === undefined
          ) {
            await source.steer(message);
            return;
          }
          const id =
            typeof message === "string" ? randomUUID() : (message.steering_id ?? randomUUID());
          identifier(id, "steering identity");
          const executionId = `steer_${id}`;
          entry.steering ??= new Map();
          const known = entry.steering.get(executionId);
          if (known !== undefined) return known;
          const operation = (async () => {
            const input: StartHostedTurnParams = {
              ...entry.input!,
              user_preview:
                typeof message === "string" ? message.slice(0, 4096) : "Operator follow-up",
              params: {
                ...entry.input!.params,
                execution_id: executionId,
                intent: "operator",
                messages: [
                  typeof message === "string" ? { role: "user", content: message } : message,
                ],
              },
            };
            delete input.params.goal_intent;
            if ((await options.acceptOperator!(input)) === "delivered") return;
            assertControl(connection, entry, observation.epoch);
            if (entry.continuationAuthority !== undefined) {
              admission.retireContinuation(entry.continuationAuthority);
              delete entry.continuationAuthority;
            }
            const delivery = Promise.withResolvers<void>();
            entry.steeringDelivery ??= new Map();
            entry.steeringDelivery.set(executionId, delivery);
            try {
              await source.steer(
                typeof message === "string"
                  ? { role: "user", content: message, steering_id: executionId }
                  : { ...message, steering_id: executionId },
              );
              await Promise.race([
                delivery.promise,
                entry.execution!.settled.then(() => {
                  if (entry.steeringDelivery?.has(executionId) === true)
                    throw kernelError(
                      "unavailable",
                      "Operator message is retained but consumption is unconfirmed",
                    );
                }),
              ]);
            } catch (error) {
              if (toKernelError(error).code !== "not_found") throw error;
              await startOperator(connection, input);
            } finally {
              entry.steeringDelivery?.delete(executionId);
            }
          })();
          entry.steering.set(executionId, operation);
          try {
            await operation;
          } finally {
            entry.steering.delete(executionId);
          }
        },
        async compact(request) {
          assertControl(connection, entry, observation.epoch);
          await source.compact(request);
        },
        async cancel() {
          assertControl(connection, entry, observation.epoch);
          await source.cancel();
        },
        async interruptTool(toolExecutionId) {
          assertControl(connection, entry, observation.epoch);
          return source.interruptTool(toolExecutionId);
        },
        async respond(response) {
          assertControl(connection, entry, observation.epoch);
          await source.respond(response);
        },
        async present(presentation) {
          assertControl(connection, entry, observation.epoch);
          return source.present === undefined
            ? { accepted: false }
            : await source.present(presentation);
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

  /**
   * Longest single wait the continuation path honors before re-asking its policy.
   *
   * @remarks A provider-requested backoff is bounded where it is classified, and the
   *   timer is clamped here as well so no duration reaching this path can be shortened
   *   silently by the platform's timer range.
   */
  const waitUntil = (instant: number, signal: AbortSignal): Promise<void> => {
    const delay = instant - now();
    if (signal.aborted || delay <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(delay, MAX_TIMER_DELAY_MS));
      signal.addEventListener("abort", finish, { once: true });
    });
  };
  const continueEntry = async (connection: ConnectionState, entry: Entry): Promise<void> => {
    const policy = entry.prepared?.continuation;
    const authority = entry.continuationAuthority;
    if (policy === undefined || authority === undefined) return;
    const stopped = (reason: "revoked" | "superseded" | "failed") =>
      stopContinuation(entry, reason);
    const revoked = () =>
      stopped(authority.signal.reason === "superseded" ? "superseded" : "revoked");
    const propose = () =>
      boundPromise(() => policy.prepare(authority.signal), {
        signal: authority.signal,
        timeoutMs: continuationTimeout,
        onTimeout: () => {
          throw kernelError("unavailable", "Continuation preparation exceeded its deadline");
        },
        onAbort: () => undefined,
      });
    try {
      const state = entry.execution?.state();
      if (state?.terminalCommitted !== true) {
        await stopped("failed");
        return;
      }
      if (authority.signal.aborted) {
        await revoked();
        return;
      }
      /**
       * The whole barrier above succeeded, so the policy is asked whether this run has a
       * successor. It rules from the durable decision its settlement recorded, not from the
       * physical shape of the predecessor: a stage that ended with a recoverable failure is
       * as continuable as one that handed off a checkpoint. A run without a continuation
       * policy stays inert, and the registry keeps exclusion, authority and the single-use
       * reservation regardless of what the policy proposes.
       */
      const proposal = await propose();
      if (authority.signal.aborted) {
        await revoked();
        return;
      }
      if (proposal === undefined) return;
      let input = proposal.input;
      if (proposal.not_before !== undefined) {
        await waitUntil(proposal.not_before, authority.signal);
        if (authority.signal.aborted) {
          await revoked();
          return;
        }
        if (now() < proposal.not_before) return;
        const refreshed = await propose();
        if (authority.signal.aborted) {
          await revoked();
          return;
        }
        if (refreshed === undefined) return;
        /**
         * A refreshed proposal is refused only while it still asks the host to wait: an
         * instant that has already passed — a bounded or zero backoff that elapsed during the
         * wait — must start its successor rather than leave the Goal with none.
         */
        if (refreshed.not_before !== undefined && refreshed.not_before > now()) return;
        input = refreshed.input;
      }
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
    } catch (error) {
      logger.warn(
        {
          event: "hosting.continuation.failed",
          execution_id: entry.ref.execution_id,
          reason: sanitizeErrorMessage(toKernelError(error).message),
        },
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
    /**
     * A guided Goal creation turn begins this conversation's Goal work, so the operator
     * connection that starts it holds the conversation's control for the stages that
     * follow — exactly as an explicit goal control claims it. Without that claim the
     * creation stage could never start its own successor, because every Goal stage
     * requires a live conversation controller; a peer that already holds the conversation
     * is still refused by the ordinary claim, which is what keeps a takeover explicit.
     */
    if (continuation === undefined && input.params.goal_intent !== undefined)
      admission.claimConversation(peer, input.session_id);
    const entry: Entry = {
      operatorInput: continuation === undefined,
      input: structuredClone(input),
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
        async delivered(event) {
          if (event.type === "steering_applied" && event.id?.startsWith("steer_") === true) {
            await options.deliverOperator?.(entry.ref.session_id, event.id, entry.ref.execution_id);
            const delivery = entry.steeringDelivery?.get(event.id);
            entry.steeringDelivery?.delete(event.id);
            delivery?.resolve();
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

  const operatorQueues = new Map<string, Promise<unknown>>();
  const submissions = new Map<string, Promise<Entry>>();
  const startOperator = async (
    connection: ConnectionState,
    input: StartHostedTurnParams,
  ): Promise<Entry> => {
    assertConnection(connection, true);
    identifier(input.session_id, "session identity");
    identifier(input.params.execution_id, "submission identity");
    if (
      typeof input.user_preview !== "string" ||
      input.user_preview.length > 4096 ||
      !["conversation", "transcript"].includes(input.kind) ||
      Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024
    )
      throw kernelError("invalid_request", "Invalid or oversized operator submission", {
        submission: "refused",
      });
    const authority = admission.claimConversation(connection.peer, input.session_id);
    const key = `${input.session_id}:${input.params.execution_id}`;
    for (const entry of entries.values()) {
      if (entry.ref.session_id !== input.session_id || entry.continuationAuthority === undefined)
        continue;
      admission.retireContinuation(entry.continuationAuthority);
      delete entry.continuationAuthority;
    }
    await options.acceptOperator!(input);
    admission.assertConversation(authority);
    const known = submissions.get(key);
    if (known !== undefined) return known;
    const existing = entries.get(input.params.execution_id);
    if (existing !== undefined) {
      if (existing.ref.session_id !== input.session_id)
        throw kernelError("conflict", "Foreign submission identity");
      await existing.preparationSettled.promise;
      if (existing.execution !== undefined) return existing;
      if (existing.ref.execution_state !== "closed")
        throw kernelError("unavailable", "Submission physical state requires recovery", {
          submission: "recovering",
        });
      await options.prepareOperator!(input.session_id, input.params.execution_id);
      entries.delete(input.params.execution_id);
    }
    const prior = operatorQueues.get(input.session_id) ?? Promise.resolve();
    const operation = prior
      .catch(() => undefined)
      .then(async () => {
        admission.assertConversation(authority);
        const active = [...entries.values()].find(
          (entry) => entry.ref.session_id === input.session_id && entry.occupancy !== undefined,
        );
        if (active !== undefined) {
          if (active.continuationAuthority !== undefined) {
            admission.retireContinuation(active.continuationAuthority);
            delete active.continuationAuthority;
          }
          await boundPromise(
            async () => {
              await active.preparationSettled.promise;
              if (active.execution !== undefined) await active.execution.settled;
            },
            {
              signal: authority.signal,
              timeoutMs: continuationTimeout,
              onTimeout: () => {
                throw kernelError(
                  "unavailable",
                  "Submission retained while previous execution settles",
                  { submission: "recovering" },
                );
              },
              onAbort: () => {
                throw kernelError("conflict", "Submission authority changed", {
                  submission: "pending",
                });
              },
            },
          );
        }
        admission.assertConversation(authority);
        if (unresolvedSessions.has(input.session_id))
          throw kernelError(
            "conflict",
            "Submission retained; verify physical closure to continue",
            { submission: "recovering", execution_id: input.params.execution_id },
          );
        const prepared = await options.prepareOperator!(
          input.session_id,
          input.params.execution_id,
        );
        admission.assertConversation(authority);
        return startEntry(connection, prepared);
      });
    submissions.set(key, operation);
    operatorQueues.set(input.session_id, operation);
    void operation
      .finally(() => {
        submissions.delete(key);
        if (operatorQueues.get(input.session_id) === operation)
          operatorQueues.delete(input.session_id);
      })
      .catch(() => undefined);
    return operation;
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
        if (input.params.intent === undefined)
          input = { ...input, params: { ...input.params, intent: "operator" } };
        try {
          const entry =
            input.params.intent === "operator" &&
            options.acceptOperator !== undefined &&
            options.prepareOperator !== undefined
              ? await startOperator(connection, input)
              : await startEntry(connection, input);
          return observe(connection, entry, "acquire");
        } catch (error) {
          const failure = toKernelError(error);
          throw kernelError(failure.code, failure.message, {
            execution_id: input.params.execution_id,
            ...(typeof failure.details === "object" && failure.details !== null
              ? failure.details
              : {}),
          });
        }
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
            throw kernelError("conflict", "preparing or non-detachable runs cannot detach");
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
              ![
                "execution_id",
                "host_generation",
                "revision",
                "physical_work_stopped",
                "disposition",
              ].includes(key),
          ) ||
          typeof input.execution_id !== "string" ||
          typeof input.host_generation !== "string" ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < 0 ||
          input.physical_work_stopped !== true ||
          (input.disposition !== undefined &&
            input.disposition !== "archive" &&
            input.disposition !== "continue")
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
          const disposition = input.disposition ?? "archive";
          const resolution = await archive(structuredClone(entry.ref), {
            kind: "operator_verified_physical_closure",
            disposition,
            previous_host_generation: entry.ref.host_generation,
            resolving_host_generation: options.hostGeneration,
            operator_connection_id: peer.id,
            resolved_at: now(),
          });
          /**
           * The conversation's own uncertainty is released only after the attestation is durable.
           *
           * @remarks A `continue` resolution lets a successor be admitted, so the record that was
           *   waiting on this execution has to stop treating it as occupied. Doing that before the
           *   commit would let a crash leave the release without its evidence; doing it for an
           *   `archive` would resume a line of work the operator asked to park.
           */
          if (disposition === "continue") await options.continueRecovery?.(entry.ref);
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
    execution(executionId) {
      const entry = entries.get(executionId);
      return entry === undefined ? undefined : view(entry);
    },
    async resumePhysical(authority) {
      admission.assertConversation(authority);
      const entry = [...entries.values()].find(
        (value) =>
          value.ref.session_id === authority.sessionId &&
          (value.occupancy !== undefined || value.ref.execution_state === "unknown"),
      );
      if (entry === undefined) return undefined;
      if (entry.ref.execution_state === "unknown")
        throw kernelError("conflict", "Physical closure must be resolved before resuming", {
          goal_outcome: "needs_input",
          action: "resolve_physical_closure",
          execution_id: entry.ref.execution_id,
        });
      if (!entry.stopRequested && entry.ref.execution_state === "running") return view(entry);
      await boundPromise(
        async () => {
          await entry.preparationSettled.promise;
          await entry.execution?.settled;
        },
        {
          signal: authority.signal,
          timeoutMs: continuationTimeout,
          onTimeout: () => {
            throw kernelError("unavailable", "Previous execution is still settling", {
              goal_outcome: "recovering",
              execution_id: entry.ref.execution_id,
            });
          },
          onAbort: () => {
            throw kernelError("conflict", "Resume superseded", { goal_outcome: "superseded" });
          },
        },
      );
      admission.assertConversation(authority);
      return entry.occupancy === undefined ? undefined : view(entry);
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
    operatorAuthorityFor({ owner, executionId }) {
      const entry = entries.get(executionId);
      if (owner !== options.owner || entry?.occupancy === undefined) return undefined;
      const scope = admission.control(entry.occupancy).interactiveScope;
      if (scope === undefined) return undefined;
      let controller = authorityScopes.get(scope);
      if (controller === undefined) {
        controller = new AbortController();
        authorityScopes.set(scope, controller);
      }
      return {
        captureInput: entry.operatorInput === true,
        binding: {
          owner_key_name: owner,
          session_id: entry.ref.session_id,
          controller_epoch: scope,
        },
        signal: controller.signal,
      };
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
