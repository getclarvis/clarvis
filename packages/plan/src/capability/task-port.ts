/**
 * The seam between the `delegation` and `plans` capabilities.
 *
 * Delegation may claim a plan task, be refused while the plan awaits approval,
 * and report what it spawned; it may never judge a task's success. Everything
 * it needs from planning arrives through this one port, so the two capabilities
 * share an interface rather than a closure — which is what lets planning move
 * out of the engine without delegation following it.
 */
import type { DelegateTaskAugmentation, SpawnGate, TaskTrackingPort } from "@clarvis/capability";
import { TASK_TRACKING_PORT } from "@clarvis/capability";
import type { PlanTaskStatus } from "../schemas.ts";

export type { DelegateTaskAugmentation, SpawnGate } from "@clarvis/capability";

/**
 * Everything the `delegation` capability may ask of the `plans` capability.
 *
 * @remarks Narrows the owner-neutral {@link TaskTrackingPort} with planning's
 *   own status vocabulary. Both producer and consumer use the canonical key
 *   from `@clarvis/capability`, so no duplicated id can drift.
 *
 *   Its absence is meaningful and must stay cheap to handle: a run with no
 *   planning gives delegation no port at all, so only the independent
 *   `spawn_subagent` tool is advertised.
 */
export interface PlanDelegationPort extends TaskTrackingPort {
  openTasks(): Array<{ id: string; status: PlanTaskStatus }>;
  getTask(id: string):
    | {
        id: string;
        title: string;
        detail?: string;
        exit?: string;
        description?: string;
        exit_condition?: string;
        status: PlanTaskStatus;
      }
    | undefined;
  /**
   * Rule on a spawn before it happens.
   *
   * @param taskId - the `task_id` the call named, if any.
   * @returns `ok`, a `refuse` carrying the text to answer the call with, or a
   *   `terminal` result. Registers `taskId` as attempted for this batch, so a
   *   second call naming it in the same iteration is refused as a duplicate.
   */
  beforeSpawn(taskId: string | undefined): Promise<SpawnGate>;
  /**
   * Record that a task was actually spawned against this batch.
   *
   * @param taskId - the resolved task id of the prepared sub-agent.
   * @remarks Read back by planning's own open-task gate to tell "every open
   *   task was just delegated" from "nothing moved", which is the difference
   *   between a nudge and a stall.
   */
  noteSpawned(taskId: string): void;
  /** The plan-aware augmentation of `delegate_task`'s schema. */
  augmentDelegateTask(): DelegateTaskAugmentation;
}

/**
 * The registry key planning publishes its task-tracking provider under.
 *
 * @remarks The run-scoped provider hands out a {@link PlanDelegationPort} for
 * one agent. It is absent when this run is not planning, which removes the
 * tracked `delegate_task` surface without affecting `spawn_subagent`.
 */
export const PLAN_PORT = TASK_TRACKING_PORT;
