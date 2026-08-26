import type { PlanDelegationPort } from "./task-port.ts";
import type { PlanSession } from "./session.ts";
import type { PlanDocument } from "../schemas.ts";

/**
 * Narrow adapter used by delegation. It deliberately exposes neither the
 * store nor plan mutation operations: delegation may claim/retry a task and
 * persist a failure, while only the plan tools can judge successful work.
 *
 * @param session - The run's live {@link PlanSession} the port reads and mutates.
 * @param onUpdated - Optional sink notified with the new document after a task
 *   transition, tagged `"recovery"` when a spawn re-opened a `failed`/`returned`
 *   task and `"task"` otherwise.
 * @returns the claim/fail half of a {@link PlanDelegationPort}, whose `markSpawned` claims a task as
 *   `in_progress` (first resetting a `failed`/`returned` task to `pending`, and
 *   refusing a task not ultimately `pending`) and whose `markFailed` records a
 *   failure only on a task currently `in_progress`; both return false when the
 *   transition does not apply.
 */
export function createDelegationPlanPort(
  session: PlanSession,
  onUpdated?: (document: PlanDocument, change: "task" | "recovery") => void,
): Pick<
  PlanDelegationPort,
  "reconcile" | "openTasks" | "getTask" | "markSpawned" | "markFailed" | "markReturned"
> {
  return {
    async reconcile(): Promise<void> {
      await session.reconcile();
    },
    openTasks() {
      return (
        session
          .cached()
          ?.tasks.filter((task) => task.status !== "done" && task.status !== "abandoned") ?? []
      );
    },
    getTask(taskId) {
      return session.cached()?.tasks.find((task) => task.id === taskId);
    },
    async markSpawned(taskId) {
      let task = await session.task(taskId);
      if (task === undefined) return false;
      if (task.status === "in_progress") return false;
      const recovering = task.status === "failed" || task.status === "returned";
      if (recovering) {
        await session.transitionCurrent({ taskId, status: "pending" });
        task = await session.task(taskId);
      }
      if (task?.status !== "pending") return false;
      const updated = await session.transitionCurrent({ taskId, status: "in_progress" });
      onUpdated?.(updated, recovering ? "recovery" : "task");
      return true;
    },
    async markFailed(taskId, error) {
      const task = await session.task(taskId);
      if (task?.status !== "in_progress") return false;
      const updated = await session.transitionCurrent({ taskId, status: "failed", error });
      onUpdated?.(updated, "task");
      return true;
    },
    async markReturned(taskId, summary) {
      const task = await session.task(taskId);
      if (task?.status !== "in_progress") return false;
      const updated = await session.transitionCurrent({
        taskId,
        status: "returned",
        result: summary,
      });
      onUpdated?.(updated, "task");
      return true;
    },
  };
}
