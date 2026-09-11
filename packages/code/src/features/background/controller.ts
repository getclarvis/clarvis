import { detachObserved } from "../../core/tasks.ts";
import type { HostedRunReceipt, HostedRunRef, HostingService } from "@clarvis/protocol";
import { createSignal, type Accessor } from "solid-js";
import { createDisposeGuard } from "../dispose-guard.ts";

/** Observable discovery and operation state, scoped to one background list view. */
export interface BackgroundListController {
  rows: Accessor<HostedRunRef[]>;
  loading: Accessor<boolean>;
  busy: Accessor<boolean>;
  failure: Accessor<string>;
  refresh: () => Promise<void>;
  attach(
    ref: HostedRunRef,
    options?: { confirmTakeover?(): Promise<boolean>; started(): void },
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  resolveRecovery(ref: HostedRunRef, confirm: () => Promise<boolean>): Promise<void>;
  dispose: () => void;
}

/**
 * Own polling, stale-result suppression and serialized list operations. The view keeps selection,
 * confirmation and rendering; the existing background actions retain execution authority.
 */
export function createBackgroundListController(deps: {
  backgrounds: BackgroundController;
  startup?: boolean;
  emit: (event: { kind: "cancel_requested" }) => void;
  scheduleRefresh?: (callback: () => void) => () => void;
}): BackgroundListController {
  const guard = createDisposeGuard(deps.emit);
  const [rows, setRows] = createSignal<HostedRunRef[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  let refreshing: Promise<void> | undefined;
  let stopTimer: (() => void) | undefined;
  const schedule =
    deps.scheduleRefresh ??
    ((callback: () => void) => {
      const timer = setTimeout(callback, 1_000);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const refresh = (): Promise<void> => {
    if (guard.isDisposed()) return Promise.resolve();
    if (refreshing !== undefined) return refreshing;
    stopTimer?.();
    const pending = Promise.resolve()
      .then(() => deps.backgrounds.list())
      .then(
        (found) => {
          if (guard.isDisposed()) return;
          setRows(
            found
              .filter((ref) => !deps.startup || ref.disconnect_policy === "continue")
              .sort(
                (a, b) =>
                  Number(a.execution_state === "closed") - Number(b.execution_state === "closed") ||
                  b.created_at - a.created_at,
              ),
          );
          setFailure("");
        },
        (error: unknown) => {
          if (!guard.isDisposed())
            setFailure(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        refreshing = undefined;
        if (!guard.isDisposed()) {
          setLoading(false);
          stopTimer = schedule(() => {
            detachObserved("background.refresh", refresh);
          });
        }
      });
    refreshing = pending;
    return pending;
  };
  return {
    rows,
    loading,
    busy,
    failure,
    refresh,
    async attach(ref, options) {
      if (guard.isDisposed() || loading() || busy()) return;
      if (ref.execution_state === "unknown")
        throw new Error(
          "The host cannot confirm this run's outcome. Its saved history remains in Sessions.",
        );
      setBusy(true);
      try {
        if (options?.confirmTakeover !== undefined && !(await options.confirmTakeover())) return;
        if (guard.isDisposed()) return;
        const result = deps.backgrounds.attach(
          ref.execution_id,
          options?.confirmTakeover === undefined ? undefined : "takeover",
        );
        options?.started();
        await result;
      } finally {
        if (!guard.isDisposed()) setBusy(false);
      }
    },
    async resolveRecovery(ref, confirm) {
      if (guard.isDisposed() || loading() || busy()) return;
      setBusy(true);
      try {
        if (!(await confirm()) || guard.isDisposed()) return;
        await deps.backgrounds.resolveRecovery(ref);
        await refresh();
      } finally {
        if (!guard.isDisposed()) setBusy(false);
      }
    },
    async cancel(id) {
      if (guard.isDisposed() || loading() || busy()) return;
      setBusy(true);
      try {
        await deps.backgrounds.cancel(id);
        guard.emit({ kind: "cancel_requested" });
        await refresh();
      } finally {
        if (!guard.isDisposed()) setBusy(false);
      }
    },
    dispose() {
      guard.dispose();
      stopTimer?.();
    },
  };
}

/** Interactive background operations; attachment observes the existing execution until it settles. */
export interface BackgroundController {
  readonly offerOnStartup: boolean;
  list(): Promise<HostedRunRef[]>;
  background(canExit?: () => boolean): Promise<void>;
  attach(id: string, control?: "observe" | "acquire" | "takeover"): Promise<void>;
  cancel(id: string): Promise<void>;
  resolveRecovery(ref: HostedRunRef): Promise<void>;
  newConversation(): void;
}

/** Compose explicit user actions without model calls, mutation retries or persisted UI authority. */
export function createBackgroundController(deps: {
  hosting(): HostingService;
  workspaceId: string;
  offerOnStartup: boolean;
  handoff(): Promise<HostedRunReceipt>;
  attach(ref: HostedRunRef, control: "observe" | "acquire" | "takeover"): Promise<void>;
  exit(receipt: HostedRunReceipt): Promise<void>;
  newConversation(): void;
}): BackgroundController {
  let handoff: Promise<void> | undefined;
  const list = async (hosting = deps.hosting()): Promise<HostedRunRef[]> =>
    (await hosting.list()).filter((ref) => ref.workspace_id === deps.workspaceId);
  const find = async (id: string, hosting = deps.hosting()): Promise<HostedRunRef> => {
    const ref = (await list(hosting)).find((entry) => entry.execution_id === id);
    if (ref === undefined) throw new Error("Hosted run not found in this workspace.");
    return ref;
  };
  return {
    offerOnStartup: deps.offerOnStartup,
    list,
    background(canExit = () => true) {
      if (handoff !== undefined) return handoff;
      const pending = (async () => {
        const receipt = await deps.handoff();
        if (!canExit())
          throw new Error("The run is in background. The TUI stayed open to preserve your input.");
        await deps.exit(receipt);
      })();
      handoff = pending;
      void pending.then(
        () => {
          if (handoff === pending) handoff = undefined;
        },
        () => {
          if (handoff === pending) handoff = undefined;
        },
      );
      return pending;
    },
    async attach(id, control) {
      const ref = await find(id);
      await deps.attach(ref, control ?? (ref.control === "other" ? "observe" : "acquire"));
    },
    async resolveRecovery(ref) {
      if (
        ref.workspace_id === deps.workspaceId &&
        ref.execution_state === "closed" &&
        ref.recovery_resolution !== undefined
      ) {
        await deps.hosting().acknowledge(ref.execution_id);
        return;
      }
      if (ref.workspace_id !== deps.workspaceId || ref.execution_state !== "unknown")
        throw new Error("Only an unknown run in this workspace can be archived.");
      const hosting = deps.hosting();
      const resolved = await hosting.resolveRecovery({
        execution_id: ref.execution_id,
        host_generation: ref.host_generation,
        revision: ref.revision,
        physical_work_stopped: true,
      });
      if (
        resolved.execution_id !== ref.execution_id ||
        resolved.host_generation !== ref.host_generation ||
        resolved.execution_state !== "closed" ||
        resolved.recovery_resolution === undefined
      )
        throw new Error("Recovery acknowledgement is inconsistent; refresh before another action.");
      await hosting.acknowledge(resolved.execution_id);
    },
    async cancel(id) {
      const hosting = deps.hosting();
      const ref = await find(id, hosting);
      if (ref.control === "other")
        throw new Error(
          "Another TUI controls this run. Take control explicitly before cancelling.",
        );
      if (ref.execution_state === "unknown" || ref.execution_state === "closed")
        throw new Error("This run has no known live execution to cancel.");
      const attachment = await hosting.attach({
        execution_id: ref.execution_id,
        host_generation: ref.host_generation,
        control: "acquire",
      });
      let failure: unknown;
      try {
        await attachment.handle.cancel();
      } catch (error) {
        failure = error;
      } finally {
        const releases = await Promise.allSettled([
          hosting.releaseSnapshot(attachment.snapshot.snapshot_id),
          hosting.releaseObservation(attachment.observation_id),
        ]);
        for (const result of releases) if (result.status === "rejected") failure ??= result.reason;
        if (ref.control === "available") {
          try {
            await hosting.closeSession(ref.session_id);
          } catch (error) {
            failure ??= error;
          }
        }
      }
      if (failure !== undefined)
        throw failure instanceof Error ? failure : new Error(String(failure));
    },
    newConversation: () => deps.newConversation(),
  };
}
