import type { HostedRunReceipt, HostedRunRef } from "@clarvis/protocol";
import type { ScheduledTurnRequest } from "./loop-schedule.ts";

export interface ScheduledReservation<Handle extends { closed: Promise<void> }> {
  readonly request: ScheduledTurnRequest;
  readonly executionId: string;
  readonly ready: Promise<void>;
  readonly cancelled: boolean;
  readonly handles: readonly Handle[];
}

export interface CoordinatorSnapshot {
  generation: number;
  loading: boolean;
  humanSubmissions: number;
  scheduledReserved: boolean;
  settlementActive: boolean;
  runActive: boolean;
  interactiveControl: boolean;
  disconnectPolicy: HostedRunRef["disconnect_policy"];
  physicalRunCount: number;
  localCommandCount: number;
  bashActive: boolean;
  compactionActive: boolean;
  compactionCalls: number;
}

interface Lease {
  readonly generation: number;
  release(): void;
}

interface Settlement {
  promise: Promise<void>;
  release(): void;
}

/** Local ownership only. The Kernel remains the authority for hosted admission. */
export function createRunCoordinator<Handle extends { closed: Promise<void> }>() {
  let generation = 0;
  let loadEpoch = 0;
  let loading = false;
  let runActive = false;
  let interactiveControl = true;
  let disconnectPolicy: HostedRunRef["disconnect_policy"] = "cancel";
  let compactionActive = false;
  let currentHandle: Handle | undefined;
  let settlement: Settlement | undefined;
  let scheduled: ScheduledReservation<Handle> | undefined;
  const scheduledState = new WeakMap<
    ScheduledReservation<Handle>,
    { cancelled: boolean; releaseReady(): void; handles: Handle[] }
  >();
  let bashAbort: AbortController | undefined;
  let handoffFlight: Promise<HostedRunReceipt> | undefined;
  let pendingHandoff: { operationId: string; executionId: string } | undefined;
  const physicalHandles = new Set<Handle>();
  const human = new Set<Lease>();
  const compactions = new Set<Lease>();
  const local = new Map<Lease, Promise<void> | undefined>();
  let notify: ((snapshot: CoordinatorSnapshot) => void) | undefined;

  const snapshot = (): CoordinatorSnapshot => ({
    generation,
    loading,
    humanSubmissions: human.size,
    scheduledReserved: scheduled !== undefined,
    settlementActive: settlement !== undefined,
    runActive,
    interactiveControl,
    disconnectPolicy,
    physicalRunCount: physicalHandles.size,
    localCommandCount: local.size,
    bashActive: bashAbort !== undefined,
    compactionActive,
    compactionCalls: compactions.size,
  });
  const changed = (): void => notify?.(snapshot());
  const lease = (set: Set<Lease>): Lease => {
    const owner: Lease = {
      generation,
      release: () => {
        if (set.delete(owner)) changed();
      },
    };
    set.add(owner);
    changed();
    return owner;
  };

  return {
    snapshot,
    observe(listener: (value: CoordinatorSnapshot) => void): void {
      notify = listener;
    },
    generation: () => generation,
    loadEpoch: () => loadEpoch,
    advanceLoadEpoch: () => ++loadEpoch,
    beginLoading(): number {
      const epoch = ++loadEpoch;
      loading = true;
      changed();
      return epoch;
    },
    finishLoading(): void {
      loading = false;
      changed();
    },
    bumpGeneration(): void {
      generation++;
      changed();
    },
    reserveHuman: () => lease(human),
    reserveCompaction: () => lease(compactions),
    setCompactionActive(value: boolean, ownerGeneration = generation): void {
      if (ownerGeneration !== generation) return;
      compactionActive = value;
      changed();
    },
    scheduled: () => scheduled,
    reserveScheduled(
      request: ScheduledTurnRequest,
      executionId: string,
    ): ScheduledReservation<Handle> {
      let resolveReady!: () => void;
      const state = {
        cancelled: false,
        releaseReady: () => resolveReady(),
        handles: [] as Handle[],
      };
      const reservation: ScheduledReservation<Handle> = {
        request,
        executionId,
        get cancelled() {
          return state.cancelled;
        },
        get handles() {
          return state.handles;
        },
        ready: new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
      };
      scheduledState.set(reservation, state);
      scheduled = reservation;
      changed();
      return reservation;
    },
    markScheduledPrepared(reservation: ScheduledReservation<Handle>): void {
      scheduledState.get(reservation)?.releaseReady();
    },
    trackScheduledHandle(reservation: ScheduledReservation<Handle>, handle: Handle): void {
      scheduledState.get(reservation)?.handles.push(handle);
    },
    releaseScheduled(reservation: ScheduledReservation<Handle>): void {
      scheduledState.get(reservation)?.releaseReady();
      if (scheduled === reservation) {
        scheduled = undefined;
        changed();
      }
    },
    cancelScheduled(reservation = scheduled): void {
      if (reservation === undefined) return;
      const state = scheduledState.get(reservation);
      if (state === undefined) return;
      state.cancelled = true;
    },
    scheduledBusy(): boolean {
      return (
        scheduled !== undefined ||
        human.size > 0 ||
        loading ||
        settlement !== undefined ||
        runActive ||
        physicalHandles.size > 0 ||
        local.size > 0 ||
        compactionActive ||
        compactions.size > 0
      );
    },
    localCommandAdmission(): "admitted" | "occupied" | "already-running" {
      if (scheduled !== undefined || human.size > 0 || loading) return "occupied";
      if (settlement !== undefined || compactions.size > 0 || physicalHandles.size > 0)
        return "occupied";
      return bashAbort === undefined ? "admitted" : "already-running";
    },
    beginLocalCommand(abort: AbortController): Lease {
      const owner: Lease = {
        generation,
        release: () => {
          if (!local.delete(owner)) return;
          if (bashAbort === abort) bashAbort = undefined;
          changed();
        },
      };
      local.set(owner, undefined);
      bashAbort = abort;
      changed();
      return owner;
    },
    setLocalWork(owner: Lease, work: Promise<void>): void {
      if (local.has(owner)) local.set(owner, work);
    },
    localWork(): Promise<void>[] {
      return [...local.values()].filter((work): work is Promise<void> => work !== undefined);
    },
    bashAbort: () => bashAbort,
    currentHandle: () => currentHandle,
    physicalHandles: (): ReadonlySet<Handle> => physicalHandles,
    settlement: () => settlement,
    beginRun(
      policy: HostedRunRef["disconnect_policy"],
      control: boolean,
    ): {
      generation: number;
      settlement: Settlement;
      releaseInteractive(): boolean;
      finish(): void;
    } {
      const ownerGeneration = generation;
      let resolve!: () => void;
      const ownedSettlement: Settlement = {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        release: () => resolve(),
      };
      settlement = ownedSettlement;
      runActive = true;
      interactiveControl = control;
      disconnectPolicy = policy;
      compactionActive = false;
      changed();
      return {
        generation: ownerGeneration,
        settlement: ownedSettlement,
        releaseInteractive: () => {
          if (generation !== ownerGeneration || settlement !== ownedSettlement) return false;
          currentHandle = undefined;
          runActive = false;
          interactiveControl = false;
          compactionActive = false;
          changed();
          return true;
        },
        finish: () => {
          if (settlement === ownedSettlement) {
            settlement = undefined;
            changed();
          }
          ownedSettlement.release();
        },
      };
    },
    trackHandle(handle: Handle): void {
      currentHandle = handle;
      physicalHandles.add(handle);
      changed();
      void handle.closed.then(
        () => {
          if (physicalHandles.delete(handle)) changed();
        },
        () => {
          if (physicalHandles.delete(handle)) changed();
        },
      );
    },
    acquireControl(handle: Handle): void {
      if (currentHandle !== handle) return;
      interactiveControl = true;
      changed();
    },
    invalidate(hosted: boolean): { currentHandle?: Handle; physicalHandles: Handle[] } {
      generation++;
      if (scheduled) {
        const state = scheduledState.get(scheduled);
        if (state) {
          state.cancelled = true;
          state.releaseReady();
        }
      }
      const oldSettlement = settlement;
      settlement = undefined;
      oldSettlement?.release();
      bashAbort?.abort();
      const previous = currentHandle;
      const observedHandles = hosted ? [...physicalHandles] : [];
      if (hosted) physicalHandles.clear();
      currentHandle = undefined;
      runActive = false;
      interactiveControl = false;
      compactionActive = false;
      changed();
      return {
        ...(previous === undefined ? {} : { currentHandle: previous }),
        physicalHandles: observedHandles,
      };
    },
    handoffFlight: () => handoffFlight,
    beginHandoff(flight: Promise<HostedRunReceipt>): void {
      handoffFlight = flight;
      void flight
        .finally(() => {
          if (handoffFlight === flight) handoffFlight = undefined;
        })
        .catch(() => undefined);
    },
    pendingHandoff: () => pendingHandoff,
    recordHandoff(executionId: string, operationId: string): void {
      pendingHandoff = { executionId, operationId };
    },
    refuseHandoff(operationId: string): void {
      if (pendingHandoff?.operationId === operationId) pendingHandoff = undefined;
    },
  };
}
