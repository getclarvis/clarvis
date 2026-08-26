import type { PlanDocument, PlanTask, PlanTaskStatus } from "./schemas.ts";

/**
 * The task-status transition matrix: for each status, the statuses it may move
 * to. `done` and `abandoned` are terminal (no outgoing transitions).
 */
const ALLOWED: Record<PlanTaskStatus, readonly PlanTaskStatus[]> = {
  pending: ["in_progress", "done", "abandoned"],
  in_progress: ["returned", "done", "failed", "pending"],
  returned: ["done", "failed", "pending"],
  failed: ["pending", "abandoned"],
  done: [],
  abandoned: [],
};

/**
 * The task statuses that `status` may legally move to.
 *
 * @param status - the task's current status.
 * @returns the allowed next statuses (empty for the terminal `done`/`abandoned`).
 */
export function allowedTaskTransitions(status: PlanTaskStatus): readonly PlanTaskStatus[] {
  return ALLOWED[status];
}

/**
 * Return a copy of `task` moved to status `to`, recording the given outcome
 * fields. This is a pure function; it never mutates `task`.
 *
 * @param task - the task to transition.
 * @param to - the target status; must be reachable from `task.status` (see
 *   {@link allowedTaskTransitions}).
 * @param detail - outcome fields to record. `done` requires a non-blank
 *   `result`, `failed` a non-blank `error`, and `abandoned` a non-blank
 *   `reason`; `assignee` is optional for any target.
 * @returns the transitioned task.
 * @throws {@link Error} if the transition is illegal or a required outcome field
 *   is missing/blank.
 */
export function transitionTask(
  task: PlanTask,
  to: PlanTaskStatus,
  detail: { result?: string; error?: string; reason?: string; assignee?: string } = {},
): PlanTask {
  if (!ALLOWED[task.status].includes(to))
    throw new Error(`Invalid task transition: ${task.status} -> ${to}`);
  if (to === "done" && !detail.result?.trim()) throw new Error("done requires result");
  if (to === "failed" && !detail.error?.trim()) throw new Error("failed requires error");
  if (to === "abandoned" && !detail.reason?.trim()) throw new Error("abandoned requires reason");
  return {
    ...task,
    status: to,
    ...(detail.result !== undefined ? { result: detail.result } : {}),
    ...(detail.error !== undefined ? { error: detail.error } : {}),
    ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    ...(detail.assignee !== undefined ? { assignee: detail.assignee } : {}),
  };
}

/** The task statuses that count as closed: no work remains and no transition leads out. */
export const CLOSED_TASK_STATUSES = ["done", "abandoned"] as const satisfies PlanTaskStatus[];

/**
 * Whether `status` is closed — see {@link CLOSED_TASK_STATUSES}.
 *
 * @remarks `failed` is *not* closed. A failed task may still move to `pending`
 *   or `abandoned`, so counting it as closed would let a plan finalize over work
 *   nobody has decided what to do about.
 */
export function isTaskClosed(status: PlanTaskStatus): boolean {
  return (CLOSED_TASK_STATUSES as readonly PlanTaskStatus[]).includes(status);
}

/**
 * Whether every task in `plan` has reached a closed state (`done` or
 * `abandoned`) — i.e. the plan has no open work left and may be finalized.
 *
 * @param plan - the plan to inspect.
 * @returns `true` if all tasks are closed (vacuously `true` for a task-less plan).
 */
export function canCompletePlan(plan: PlanDocument): boolean {
  return plan.tasks.every((task) => isTaskClosed(task.status));
}

/**
 * Whether `plan` is sealed: a completed plan is a final record of work that is
 * over, and its substance may no longer change.
 *
 * @param plan - the plan to inspect.
 * @returns `true` only for `completed`.
 *
 * @remarks `cancelled` and `failed` are deliberately **not** sealed. Those
 *   describe work that stopped, not work that finished, and continuing such a
 *   run is meant to resume the plan where it was left — which is why
 *   continuation resets their `in_progress` tasks and returns them to `active`.
 *   Only `completed` says there is nothing left to resume.
 *
 *   One edit survives the seal, and it is the reason this is a predicate rather
 *   than a blanket freeze: an **open** task may still be **closed**. A run that
 *   did the work and forgot to record it leaves exactly that residue, and the
 *   correction is bookkeeping — it changes what the document says was done, not
 *   what the plan was. Every other edit on a sealed plan is a rewrite of
 *   history: see {@link PlanSealedError}.
 */
export function isPlanSealed(plan: Pick<PlanDocument, "status">): boolean {
  return plan.status === "completed";
}

/**
 * The message a refused revision of a sealed plan reports.
 *
 * @param id - the sealed plan's id.
 *
 * @remarks It names the way forward, because the model reads this verbatim and
 *   acts on it: the previous refusal on this path said "change it with
 *   revise_plan", and the model dutifully did, ten times.
 */
export function sealedRevisionMessage(id: string): string {
  return (
    `Plan ${id} is completed and is a final record: it cannot be revised. Create the next plan ` +
    `with create_plan; a task an earlier run left open can still be closed with ` +
    `transition_plan_task.`
  );
}

/**
 * The message a refused task transition on a sealed plan reports.
 *
 * @param id - the sealed plan's id.
 * @param to - the target status that was refused.
 */
export function sealedTransitionMessage(id: string, to: PlanTaskStatus): string {
  return (
    `Plan ${id} is completed and is a final record: an open task may only be closed ` +
    `(${CLOSED_TASK_STATUSES.join(" or ")}), not moved to ${to}. Create the next plan with ` +
    `create_plan to start new work.`
  );
}
