import type { PlanProjection, PlanTaskDto, RunEvent } from "@clarvis/protocol";

/** One plan task as projected for the UI from a {@link PlanTaskDto}. */
export interface PlanTaskActivity {
  id: string;
  title: string;
  status: string;
  description?: string;
  exit_condition?: string;
  assignee?: string;
  result?: string;
  error?: string;
  reason?: string;
}

/** The live plan document as projected for the transcript block, overlay, and sidebar. */
export interface PlanActivity {
  /** The plan's stable identity — how the overlay addresses it. */
  id: string;
  /** Workspace-relative file path when the backend has one; display only. */
  path?: string;
  title: string;
  status: PlanProjection["status"];
  retention: PlanProjection["retention"];
  revision: number;
  spec_revision: number;
  tasks: PlanTaskActivity[];
  reviewOutcome?: string;
  removed?: boolean;
  error?: { code: string; message: string };
}

/** Whether a projected plan is still actionable rather than historical. */
export function isLivePlan(plan: PlanActivity | null | undefined): plan is PlanActivity {
  return (
    plan !== null &&
    plan !== undefined &&
    !plan.removed &&
    (plan.status === "active" || plan.status === "awaiting_approval")
  );
}

/** Whether the backing record disappeared because the user's retention policy asked it to. */
export function isExpectedPlanDiscard(
  plan: Pick<PlanActivity, "removed" | "status" | "retention">,
): boolean {
  return plan.removed === true && plan.status === "completed" && plan.retention === "discard";
}

/** Whether plan detail is still available, including a retained terminal outcome. */
export function isAvailablePlan(plan: PlanActivity | null | undefined): plan is PlanActivity {
  return plan !== null && plan !== undefined && !plan.removed;
}

/** The plan-related run events this projection folds. */
export type PlanProjectionEvent = Extract<
  RunEvent,
  {
    type:
      | "plan_created"
      | "plan_updated"
      | "plan_removed"
      | "plan_review_requested"
      | "plan_review_resolved";
  }
>;

function taskActivity(task: PlanTaskDto): PlanTaskActivity {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.detail ? { description: task.detail } : {}),
    ...(task.exit ? { exit_condition: task.exit } : {}),
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(task.result ? { result: task.result } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
  };
}

function planTasks(tasks: PlanTaskDto[]): PlanTaskActivity[] {
  return tasks.map(taskActivity);
}

/** The single event → UI projection reducer used by live and rehydrated runs. */
export function reducePlanProjection(
  current: PlanActivity | null,
  event: PlanProjectionEvent,
): PlanActivity | null {
  // A reconnect/readback can finish after a newer live transition. Revision is
  // provider-owned and monotonic for one plan, so an older projection must not
  // move the sidebar's current task backwards.
  if (current?.id === event.id && event.revision < current.revision) return current;

  if (event.type === "plan_removed") {
    if (!current || current.id !== event.id)
      return {
        id: event.id,
        ...(event.path === undefined ? {} : { path: event.path }),
        title: event.title ?? "Plan unavailable",
        status: event.status ?? "failed",
        retention: event.retention ?? "keep",
        revision: event.revision,
        spec_revision: event.spec_revision,
        tasks: event.tasks === undefined ? [] : planTasks(event.tasks),
        removed: true,
      };
    return {
      ...current,
      revision: event.revision,
      spec_revision: event.spec_revision,
      ...(event.title ? { title: event.title } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.retention ? { retention: event.retention } : {}),
      ...(event.tasks ? { tasks: planTasks(event.tasks) } : {}),
      removed: true,
    };
  }

  const reviewOutcome =
    event.type === "plan_review_resolved"
      ? event.outcome
      : current && current.id === event.id
        ? current.reviewOutcome
        : undefined;
  return {
    id: event.id,
    ...(event.path === undefined ? {} : { path: event.path }),
    title: event.title,
    status: event.status,
    retention: event.retention,
    revision: event.revision,
    spec_revision: event.spec_revision,
    tasks: planTasks(event.tasks),
    ...(reviewOutcome ? { reviewOutcome } : {}),
  };
}

/**
 * The task the plan overlay should highlight as "current": the in-progress
 * task, else the most recently returned one, else the next pending one.
 */
export function currentPlanTask(plan: PlanActivity): PlanTaskActivity | undefined {
  return (
    plan.tasks.find((task) => task.status === "in_progress") ??
    plan.tasks.find((task) => task.status === "returned") ??
    plan.tasks.find((task) => task.status === "pending")
  );
}
