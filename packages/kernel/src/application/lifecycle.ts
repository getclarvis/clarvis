import { detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { observationSink } from "../core/observed.ts";

/** A long-lived resource owned by a kernel runtime. */
export interface KernelResource {
  /** Cancel or dispose the resource. Calls must be safe when repeated. */
  close(): void | Promise<void>;
}

/** Lifecycle state used to gate admission and make shutdown observable. */
export type KernelLifecycleState = "open" | "closing" | "closed";

/** Registry that owns every resource created during a kernel's lifetime. */
export interface KernelLifecycle {
  /** Current admission and shutdown state. */
  readonly state: KernelLifecycleState;
  /**
   * Register a resource for shutdown.
   *
   * @returns a function that releases ownership after natural disposal.
   */
  register(resource: KernelResource): () => void;
  /** Close all resources, retaining failed disposals for a later retry without reopening admission. */
  close(): Promise<void>;
}

/**
 * Create an idempotent resource registry.
 *
 * @returns an open lifecycle whose first `close` stops admission and disposes
 *   resources in reverse registration order. Concurrent calls share an attempt;
 *   failed resources remain owned and later calls retry only those failures.
 */
export function createKernelLifecycle(logger: Logger = NOOP_LOGGER): KernelLifecycle {
  let state: KernelLifecycleState = "open";
  let closing: Promise<void> | undefined;
  const resources = new Set<KernelResource>();

  return {
    get state(): KernelLifecycleState {
      return state;
    },
    register(resource): () => void {
      if (state !== "open") {
        detachObserved(() => resource.close(), {
          operation: "kernel_late_resource_close",
          logger: observationSink(logger, "lifecycle.late_close_failed"),
        });
        return () => {};
      }
      resources.add(resource);
      return () => {
        resources.delete(resource);
      };
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      state = "closing";
      const snapshot = [...resources].reverse();
      closing = (async () => {
        const outcomes = await Promise.allSettled(
          snapshot.map(async (resource) => {
            await resource.close();
            resources.delete(resource);
          }),
        );
        const failures: unknown[] = [];
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") failures.push(outcome.reason as unknown);
        }
        if (failures.length > 0) {
          closing = undefined;
          throw new AggregateError(failures, "one or more kernel resources failed to close");
        }
        state = "closed";
      })();
      return closing;
    },
  };
}
