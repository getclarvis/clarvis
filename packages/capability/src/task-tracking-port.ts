import type { AgentBuildContext } from "./loop-contract.ts";
import type { AgentResult } from "./agent-result.ts";
import { portKey } from "./services.ts";

/** A task tracker's ruling on a child spawn before it begins. */
export type SpawnGate =
  { kind: "ok" } | { kind: "refuse"; text: string } | { kind: "terminal"; result: AgentResult };

/** A task tracker's contribution to the delegation tool's advertised schema. */
export interface DelegateTaskAugmentation {
  description: string;
  properties: { task_id: Record<string, unknown> } & Record<string, unknown>;
}

/** One tracked work item, in the neutral shape delegation consumes. */
export interface TrackedTask {
  id: string;
  title: string;
  status: string;
  detail?: string;
  exit?: string;
  description?: string;
  exit_condition?: string;
}

/** The task-tracking operations a child-producing capability may consume. */
export interface TaskTrackingPort {
  reconcile?(): Promise<void>;
  openTasks(): Array<{ id: string; status: string }>;
  getTask(id: string): TrackedTask | undefined;
  markSpawned(id: string): Promise<boolean> | boolean;
  markFailed(
    id: string,
    error: string,
  ):
    | Promise<boolean>
    | boolean
    | { digest: string; original_chars: number; digest_chars: number }
    | undefined;
  /**
   * Record that a child handed work back, before the parent has judged it.
   *
   * @param id - the tracked task the child was spawned against.
   * @param summary - the child's returned text, for the tracker's audit trail.
   * @returns whether the task moved.
   * @remarks Optional so a tracker that has no such state is unaffected. Its
   *   absence was itself a defect: delegation called the port on the *failure*
   *   path only, so a successful hand-back went straight from `in_progress` to
   *   whatever the parent decided next, and the documented intermediate state
   *   — "a sub-agent's return lands there and the lead must judge it
   *   explicitly" — was never written by anything. Delegation must not close
   *   the task itself: only the parent may, through `transition_plan_task`.
   */
  markReturned?(id: string, summary: string): Promise<boolean> | boolean;
  beforeSpawn(taskId: string | undefined): Promise<SpawnGate>;
  noteSpawned(taskId: string): void;
  augmentDelegateTask(): DelegateTaskAugmentation;
}

/** Hands out the task-tracking port bound to one agent build context. */
export interface TaskTrackingProvider {
  forAgent(bc: AgentBuildContext): TaskTrackingPort | undefined;
}

/** Canonical, owner-neutral service key for optional task tracking. */
export const TASK_TRACKING_PORT = portKey<TaskTrackingProvider>("delegation.task-tracking");
