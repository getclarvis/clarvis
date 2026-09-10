import { randomUUID } from "node:crypto";
import { createSignal, type Accessor } from "solid-js";
import type {
  GoalControlAction,
  GoalControlRequest,
  GoalReceipt,
  GoalService,
  GoalView,
} from "@clarvis/protocol";
import { detachObserved } from "../../core/tasks.ts";

/** Local presentation generation fences late work; only sessionId crosses the goal service seam. */
export interface GoalBinding {
  sessionId: string;
  generation: number;
}

export interface GoalController {
  binding: Accessor<GoalBinding | null>;
  view: Accessor<GoalView | undefined>;
  available: Accessor<boolean>;
  busy: Accessor<boolean>;
  loading: Accessor<boolean>;
  failure: Accessor<string>;
  pendingOperation: Accessor<string | undefined>;
  refresh(): Promise<void>;
  control(
    action: GoalControlAction,
    expectedRevision?: number,
    expectedBinding?: GoalBinding | null,
  ): Promise<GoalReceipt>;
  recover(): Promise<GoalReceipt | null>;
  reset(): void;
  dispose(): void;
}

interface Observation {
  binding: GoalBinding;
  service: GoalService;
  off?: () => void;
  subscribed: boolean;
  dirty: boolean;
  refresh?: Promise<void>;
}

/**
 * Present canonical state and serialize explicit user controls. Notifications only invalidate a
 * read; this controller has no run-start port or continuation timer. An uncertain mutation retains
 * its operation identity across reconnects and is recovered by receipt lookup without resubmission.
 */
export function createGoalController(deps: {
  binding(): GoalBinding | null;
  prepare(): Promise<GoalBinding>;
  service(): GoalService;
  updated?(binding: GoalBinding, view: GoalView): void;
  operationId?(): string;
}): GoalController {
  const [view, setView] = createSignal<GoalView>();
  const [available, setAvailable] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [pendingOperation, setPendingOperation] = createSignal<string>();
  const pending = new Map<string, GoalControlRequest>();
  let observation: Observation | undefined;
  let disposed = false;
  let emptyRead = 0;
  const same = (a: GoalBinding, b: GoalBinding | null): boolean =>
    a.sessionId === b?.sessionId && a.generation === b.generation;
  const current = (entry: Observation): boolean =>
    !disposed && observation === entry && same(entry.binding, deps.binding());
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : "Goal operation failed.";
  const reset = (): void => {
    emptyRead++;
    observation?.off?.();
    observation = undefined;
    setView(undefined);
    setAvailable(false);
    setLoading(false);
    setFailure("");
    setPendingOperation(pending.get(deps.binding()?.sessionId ?? "")?.operation_id);
  };
  const observe = (binding: GoalBinding): Observation => {
    if (observation !== undefined && same(binding, observation.binding)) return observation;
    reset();
    observation = {
      binding: { ...binding },
      service: deps.service(),
      subscribed: false,
      dirty: false,
    };
    return observation;
  };
  const refreshEntry = (entry: Observation): Promise<void> => {
    entry.dirty = true;
    if (entry.refresh !== undefined) return entry.refresh;
    let refreshed = false;
    const task = async (): Promise<void> => {
      if (!current(entry)) return;
      setLoading(true);
      try {
        const availability = await entry.service.availability();
        if (!current(entry)) return;
        setAvailable(availability.available);
        if (!availability.available) {
          setFailure(availability.reason ?? "Goals are unavailable on this host.");
          return;
        }
        if (!entry.subscribed) {
          const off = await entry.service.subscribe(entry.binding.sessionId, () => {
            if (current(entry)) detachObserved("goal.refresh", () => refreshEntry(entry));
          });
          if (!current(entry)) {
            off();
            return;
          }
          entry.off = off;
          entry.subscribed = true;
        }
        while (entry.dirty && current(entry)) {
          entry.dirty = false;
          const next = await entry.service.get(entry.binding.sessionId);
          if (!current(entry)) return;
          setView(next);
          setFailure("");
          deps.updated?.(entry.binding, next);
        }
        refreshed = true;
      } catch (error) {
        if (current(entry)) setFailure(message(error));
        throw error;
      } finally {
        if (current(entry)) setLoading(false);
      }
    };
    entry.refresh = Promise.resolve()
      .then(task)
      .finally(() => {
        entry.refresh = undefined;
        if (refreshed && entry.dirty && current(entry))
          detachObserved("goal.refresh", () => refreshEntry(entry));
      });
    return entry.refresh;
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const binding = deps.binding();
    if (binding !== null) return refreshEntry(observe(binding));
    reset();
    const epoch = emptyRead;
    setLoading(true);
    try {
      const status = await deps.service().availability();
      if (disposed || epoch !== emptyRead || deps.binding() !== null) return;
      setAvailable(status.available);
      setFailure(status.available ? "" : (status.reason ?? "Goals are unavailable on this host."));
    } finally {
      if (!disposed && epoch === emptyRead) setLoading(false);
    }
  };
  const lookup = async (entry: Observation): Promise<GoalReceipt | null> => {
    const request = pending.get(entry.binding.sessionId);
    if (request === undefined) return null;
    const receipt = await entry.service.receipt(request.session_id, request.operation_id);
    if (receipt !== null && pending.get(request.session_id) === request) {
      pending.delete(request.session_id);
      if (current(entry)) setPendingOperation(undefined);
    }
    return receipt;
  };
  const definiteRefusal = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    return [
      "invalid_request",
      "unauthorized",
      "forbidden",
      "conflict",
      "unsupported",
      "not_found",
      "resource_exhausted",
    ].includes(String(error.code));
  };
  return {
    binding: () => deps.binding(),
    view,
    available,
    busy,
    loading,
    failure,
    pendingOperation,
    refresh,
    reset,
    async control(action, expectedRevision, expectedBinding) {
      if (disposed || busy())
        throw new Error("A goal operation is already running or the interface is closed.");
      if (
        expectedBinding !== undefined &&
        (expectedBinding === null
          ? deps.binding() !== null
          : !same(expectedBinding, deps.binding()))
      )
        throw new Error(
          "The reviewed goal belongs to another conversation. Reopen it before saving.",
        );
      const snapshot = structuredClone(action);
      setBusy(true);
      let entry: Observation | undefined;
      try {
        const binding = snapshot.kind === "create" ? await deps.prepare() : deps.binding();
        if (disposed || binding === null || !same(binding, deps.binding()))
          throw new Error("The goal conversation changed.");
        entry = observe(binding);
        if (pending.has(binding.sessionId))
          throw new Error(
            "The previous goal change is unconfirmed. Recover its receipt before another change.",
          );
        if (pending.size >= 32)
          throw new Error(
            "Too many unconfirmed goal changes. Recover earlier conversations first.",
          );
        await refreshEntry(entry);
        if (!current(entry)) throw new Error("The goal conversation changed.");
        if (!available() || view() === undefined)
          throw new Error(failure() || "Goal state is unavailable.");
        const request: GoalControlRequest = {
          session_id: binding.sessionId,
          expected_revision: expectedRevision ?? view()!.state.revision,
          operation_id: (deps.operationId ?? randomUUID)(),
          action: snapshot,
        };
        pending.set(binding.sessionId, request);
        setPendingOperation(request.operation_id);
        let receipt: GoalReceipt;
        try {
          receipt = await entry.service.control(request);
          pending.delete(binding.sessionId);
          if (current(entry)) setPendingOperation(undefined);
        } catch (error) {
          let recovered: GoalReceipt | null;
          try {
            recovered = await lookup(entry);
          } catch {
            throw error;
          }
          if (recovered === null) {
            if (definiteRefusal(error)) {
              pending.delete(binding.sessionId);
              if (current(entry)) setPendingOperation(undefined);
            }
            throw error;
          }
          receipt = recovered;
        }
        if (current(entry)) await refreshEntry(entry);
        return receipt;
      } catch (error) {
        if (entry === undefined || current(entry)) setFailure(message(error));
        throw error;
      } finally {
        setBusy(false);
      }
    },
    async recover() {
      if (disposed || busy())
        throw new Error("A goal operation is already running or the interface is closed.");
      const binding = deps.binding();
      if (binding === null) return null;
      const entry = observe(binding);
      setBusy(true);
      try {
        const receipt = await lookup(entry);
        if (current(entry)) {
          await refreshEntry(entry);
          if (pending.has(binding.sessionId))
            setFailure(
              "The host has not confirmed the previous goal change. No mutation was repeated.",
            );
        }
        return receipt;
      } finally {
        setBusy(false);
      }
    },
    dispose() {
      disposed = true;
      reset();
    },
  };
}
