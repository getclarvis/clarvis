import { randomUUID } from "node:crypto";
import { kernelError } from "../core/errors.ts";

/** Host-created identity after local authentication; it is never reconstructed from an RPC DTO. */
export interface HostingPeer {
  readonly id: string;
  readonly role: "operator" | "observer";
}

/** Physical conversation occupancy; only its owning host may release it after teardown. */
export interface HostedOccupancy {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId?: string;
  readonly kind: "run" | "shell" | "compaction";
}

/** Mutable control identity, separate from physical occupancy and persisted conversation ids. */
export interface HostedControl {
  readonly epoch: number;
  readonly peerId?: string;
  /** Volatile consent scope, available only while a controlling TUI owns this conversation. */
  readonly interactiveScope?: string;
}

/** Host-only continuation authority captured from the real controller of one admitted execution. */
export interface HostedContinuationAuthority {
  readonly sessionId: string;
  readonly executionId: string;
  /** Revoked by a new reservation, takeover, conversation close or disconnection. */
  readonly signal: AbortSignal;
}

/** Live conversation-controller proof for host control transactions, including between stages. */
export interface HostedConversationAuthority {
  readonly sessionId: string;
  readonly peerId: string;
  readonly signal: AbortSignal;
}

/** Host-wide admission and interactive authority limits. */
export interface HostedAdmissionOptions {
  maxConnections?: number;
  maxRuns?: number;
  maxActivities?: number;
  maxSessionScopes?: number;
  /** Synchronously retire native-configuration and shell-session consent for this one scope. */
  revokeInteractiveScope(scope: string): void;
}

/**
 * Physical occupancy and interactive control have independent lifetimes.
 *
 * Reserve before asynchronous preparation. Disconnecting a TUI revokes its authority immediately
 * but does not release physical work: the registry decides cancel/continue, then calls release
 * after its run, event pump and persistence have actually settled.
 */
export interface HostedAdmission {
  connect(role: HostingPeer["role"]): HostingPeer;
  disconnect(peer: HostingPeer): readonly HostedOccupancy[];
  reserve(
    peer: HostingPeer,
    sessionId: string,
    kind: HostedOccupancy["kind"],
    executionId?: string,
  ): HostedOccupancy;
  /** Host-only physical completion, not a client cancellation acknowledgement. */
  release(occupancy: HostedOccupancy): void;
  control(occupancy: HostedOccupancy): HostedControl;
  acquire(peer: HostingPeer, occupancy: HostedOccupancy, takeover?: boolean): HostedControl;
  assertControl(peer: HostingPeer, occupancy: HostedOccupancy, epoch: number): void;
  captureContinuation(peer: HostingPeer, occupancy: HostedOccupancy): HostedContinuationAuthority;
  /** Reserve once after physical release, using the original live peer rather than a synthetic connection. */
  reserveContinuation(authority: HostedContinuationAuthority, executionId: string): HostedOccupancy;
  /** Retire a finished or abandoned continuation without releasing physical work. */
  retireContinuation(authority: HostedContinuationAuthority): void;
  claimConversation(
    peer: HostingPeer,
    sessionId: string,
    takeover?: boolean,
  ): HostedConversationAuthority;
  assertConversation(authority: HostedConversationAuthority): void;
  hasConversation(sessionId: string): boolean;
  conversation(peer: HostingPeer, sessionId: string): HostedConversationAuthority | undefined;
  releaseConversation(authority: HostedConversationAuthority): void;
  /** Retire a conversation instance on switch/resume even when the same TUI connection survives. */
  closeSession(peer: HostingPeer, sessionId: string): void;
  occupied(sessionId: string): boolean;
  stats(): { connections: number; runs: number; activities: number; consent_scopes: number };
}

interface PeerState {
  peer: HostingPeer;
  scopes: Map<string, string>;
}

interface OccupancyState {
  occupancy: HostedOccupancy;
  control: HostedControl;
}

interface ContinuationState {
  authority: HostedContinuationAuthority;
  peer: HostingPeer;
  abort: AbortController;
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function identifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw kernelError("invalid_request", `${name} must contain between 1 and 256 characters`);
  }
}

/** Create one bounded authority for a canonical workspace and authenticated data owner. */
export function createHostedAdmission(options: HostedAdmissionOptions): HostedAdmission {
  const maxConnections = limit(options.maxConnections ?? 4, "maxConnections");
  const maxRuns = limit(options.maxRuns ?? 2, "maxRuns");
  const maxActivities = limit(options.maxActivities ?? 4, "maxActivities");
  const maxSessionScopes = limit(options.maxSessionScopes ?? 64, "maxSessionScopes");
  const peers = new Map<string, PeerState>();
  const work = new Map<string, OccupancyState>();
  const sessions = new Map<string, HostedOccupancy>();
  const continuations = new Map<string, ContinuationState>();
  const controllers = new Map<
    string,
    { peer: HostingPeer; authority: HostedConversationAuthority; abort: AbortController }
  >();
  let runs = 0;
  let activities = 0;

  const peerState = (peer: HostingPeer, operator = false): PeerState => {
    const state = peers.get(peer.id);
    if (state?.peer !== peer || (operator && peer.role !== "operator")) {
      throw kernelError("unauthorized", "interactive authority is absent or retired");
    }
    return state;
  };

  const workState = (occupancy: HostedOccupancy): OccupancyState => {
    const state = work.get(occupancy.id);
    if (state?.occupancy !== occupancy)
      throw kernelError("not_found", "physical activity has already closed");
    return state;
  };

  const scopeFor = (state: PeerState, sessionId: string): string => {
    const existing = state.scopes.get(sessionId);
    if (existing !== undefined) return existing;
    if (state.scopes.size >= maxSessionScopes)
      throw kernelError("resource_exhausted", "too many open interactive conversations");
    const scope = randomUUID();
    state.scopes.set(sessionId, scope);
    return scope;
  };

  const revokeContinuation = (sessionId: string, reason = "revoked"): void => {
    const pending = continuations.get(sessionId);
    if (pending === undefined) return;
    continuations.delete(sessionId);
    pending.abort.abort(reason);
  };

  const retire = (state: PeerState, sessionId: string): void => {
    const controller = controllers.get(sessionId);
    if (controller?.peer === state.peer) {
      controllers.delete(sessionId);
      controller.abort.abort();
    }
    if (continuations.get(sessionId)?.peer === state.peer) revokeContinuation(sessionId);
    const scope = state.scopes.get(sessionId);
    if (scope === undefined) return;
    state.scopes.delete(sessionId);
    options.revokeInteractiveScope(scope);
  };

  const releaseControl = (state: OccupancyState): void => {
    revokeContinuation(state.occupancy.sessionId);
    const previous =
      state.control.peerId === undefined ? undefined : peers.get(state.control.peerId);
    state.control = { epoch: state.control.epoch + 1 };
    if (previous !== undefined) retire(previous, state.occupancy.sessionId);
  };

  const reserve = (
    peer: HostingPeer,
    sessionId: string,
    kind: HostedOccupancy["kind"],
    executionId?: string,
  ): HostedOccupancy => {
    const state = peerState(peer, true);
    identifier(sessionId, "session id");
    if (controllers.has(sessionId) && controllers.get(sessionId)!.peer !== peer)
      throw kernelError(
        "conflict",
        "conversation belongs to another controller; explicit takeover is required",
      );
    if (kind !== "run" && kind !== "shell" && kind !== "compaction")
      throw kernelError("invalid_request", "unknown activity kind");
    if (kind === "run") identifier(executionId!, "execution id");
    else if (executionId !== undefined)
      throw kernelError("invalid_request", "local activity cannot claim an execution id");
    if (sessions.has(sessionId))
      throw kernelError("conflict", "conversation still owns physical work");
    if (kind === "run" ? runs >= maxRuns : activities >= maxActivities)
      throw kernelError("resource_exhausted", "workspace activity limit reached");
    const scope = scopeFor(state, sessionId);
    revokeContinuation(sessionId, "superseded");
    const occupancy: HostedOccupancy = Object.freeze({
      id: randomUUID(),
      sessionId,
      kind,
      ...(executionId === undefined ? {} : { executionId }),
    });
    work.set(occupancy.id, {
      occupancy,
      control: { epoch: 1, peerId: peer.id, interactiveScope: scope },
    });
    sessions.set(sessionId, occupancy);
    if (kind === "run") runs += 1;
    else activities += 1;
    return occupancy;
  };

  const claimConversation = (
    peer: HostingPeer,
    sessionId: string,
    takeover = false,
  ): HostedConversationAuthority => {
    const state = peerState(peer, true);
    identifier(sessionId, "session id");
    const physical = sessions.get(sessionId);
    if (physical !== undefined && workState(physical).control.peerId !== peer.id)
      throw kernelError("conflict", "conversation belongs to another execution controller");
    const existing = controllers.get(sessionId);
    if (existing !== undefined) {
      if (existing.peer === peer) return existing.authority;
      if (!takeover)
        throw kernelError("conflict", "conversation controller must be taken over explicitly");
      scopeFor(state, sessionId);
      retire(peerState(existing.peer), sessionId);
    }
    scopeFor(state, sessionId);
    const abort = new AbortController();
    const authority = Object.freeze({ sessionId, peerId: peer.id, signal: abort.signal });
    controllers.set(sessionId, { peer, authority, abort });
    return authority;
  };

  return {
    connect(role) {
      if (role !== "operator" && role !== "observer")
        throw kernelError("invalid_request", "unknown local role");
      if (peers.size >= maxConnections)
        throw kernelError("resource_exhausted", "local host client limit reached");
      const peer: HostingPeer = Object.freeze({ id: randomUUID(), role });
      peers.set(peer.id, { peer, scopes: new Map() });
      return peer;
    },
    disconnect(peer) {
      const state = peers.get(peer.id);
      if (state?.peer !== peer) return [];
      peers.delete(peer.id);
      for (const [id, controller] of controllers)
        if (controller.peer === peer) {
          controllers.delete(id);
          controller.abort.abort();
        }
      for (const [sessionId, pending] of continuations)
        if (pending.peer === peer) revokeContinuation(sessionId);
      const scopes = [...state.scopes.values()];
      state.scopes.clear();
      const owned: HostedOccupancy[] = [];
      for (const item of work.values()) {
        if (item.control.peerId !== peer.id) continue;
        owned.push(item.occupancy);
        releaseControl(item);
      }
      const errors: unknown[] = [];
      for (const scope of scopes) {
        try {
          options.revokeInteractiveScope(scope);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "interactive consent retirement failed");
      return owned;
    },
    reserve,
    claimConversation,
    hasConversation: (sessionId) => controllers.has(sessionId),
    conversation(peer, sessionId) {
      peerState(peer, true);
      const current = controllers.get(sessionId);
      return current?.peer === peer ? current.authority : undefined;
    },
    assertConversation(authority) {
      const controller = controllers.get(authority.sessionId);
      if (controller?.authority !== authority || authority.signal.aborted)
        throw kernelError("conflict", "conversation control has been retired");
      peerState(controller.peer, true);
      const physical = sessions.get(authority.sessionId);
      if (physical !== undefined && workState(physical).control.peerId !== authority.peerId)
        throw kernelError("conflict", "conversation execution control changed");
    },
    releaseConversation(authority) {
      const controller = controllers.get(authority.sessionId);
      if (controller?.authority !== authority) return;
      controllers.delete(authority.sessionId);
      controller.abort.abort();
    },
    captureContinuation(peer, occupancy) {
      peerState(peer, true);
      const state = workState(occupancy);
      if (occupancy.kind !== "run" || state.control.peerId !== peer.id)
        throw kernelError("conflict", "continuation requires the bound execution controller");
      const existing = continuations.get(occupancy.sessionId);
      if (
        existing !== undefined &&
        existing.authority.executionId === occupancy.executionId &&
        existing.peer === peer
      )
        return existing.authority;
      revokeContinuation(occupancy.sessionId);
      const abort = new AbortController();
      const authority = Object.freeze({
        sessionId: occupancy.sessionId,
        executionId: occupancy.executionId!,
        signal: abort.signal,
      });
      continuations.set(occupancy.sessionId, { authority, peer, abort });
      return authority;
    },
    reserveContinuation(authority, executionId) {
      const pending = continuations.get(authority.sessionId);
      if (pending?.authority !== authority || authority.signal.aborted)
        throw kernelError("conflict", "continuation authority has been superseded or retired");
      return reserve(pending.peer, authority.sessionId, "run", executionId);
    },
    retireContinuation(authority) {
      if (continuations.get(authority.sessionId)?.authority === authority)
        revokeContinuation(authority.sessionId);
    },
    release(occupancy) {
      if (work.get(occupancy.id)?.occupancy !== occupancy) return;
      work.delete(occupancy.id);
      sessions.delete(occupancy.sessionId);
      if (occupancy.kind === "run") runs -= 1;
      else activities -= 1;
    },
    control: (occupancy) => ({ ...workState(occupancy).control }),
    acquire(peer, occupancy, takeover = false) {
      const owner = peerState(peer, true);
      const state = workState(occupancy);
      if (state.control.peerId === peer.id) return { ...state.control };
      if (state.control.peerId !== undefined && !takeover) {
        throw kernelError("conflict", "another TUI controls this conversation");
      }
      const scope = scopeFor(owner, occupancy.sessionId);
      const conversationControlled = controllers.has(occupancy.sessionId);
      releaseControl(state);
      state.control = { epoch: state.control.epoch, peerId: peer.id, interactiveScope: scope };
      if (conversationControlled) claimConversation(peer, occupancy.sessionId);
      return { ...state.control };
    },
    assertControl(peer, occupancy, epoch) {
      peerState(peer, true);
      const state = workState(occupancy);
      if (state.control.peerId !== peer.id || state.control.epoch !== epoch) {
        throw kernelError(
          "conflict",
          "interactive control changed; attach again before controlling this run",
        );
      }
    },
    closeSession(peer, sessionId) {
      const state = peerState(peer);
      for (const item of work.values()) {
        if (item.occupancy.sessionId === sessionId && item.control.peerId === peer.id)
          releaseControl(item);
      }
      retire(state, sessionId);
    },
    occupied: (sessionId) => sessions.has(sessionId),
    stats: () => ({
      connections: peers.size,
      runs,
      activities,
      consent_scopes: [...peers.values()].reduce((sum, peer) => sum + peer.scopes.size, 0),
    }),
  };
}
