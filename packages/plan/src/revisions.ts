import { z } from "zod";
import {
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_SECTION_CHARS,
  MAX_PLAN_TASK_FIELD_CHARS,
  MAX_PLAN_TITLE_CHARS,
  MAX_PLAN_VALIDATION_ITEMS,
} from "./limits.ts";
import { singleLineSchema, taskTitleSchema, type PlanDocument, type PlanTask } from "./schemas.ts";

const taskContentSchema = z.object({
  title: taskTitleSchema,
  detail: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  exit: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
});

/**
 * A single structural edit to a plan, discriminated by `type`:
 * `set_title` | `set_objective` | `set_context` | `set_validation` (field
 * replacements) and `add_task` | `edit_task` | `remove_task` | `reorder_task`
 * (task-list edits). Task ids referenced by an operation must match `t[1-9]\d*`;
 * `reorder_task`/`add_task` position relative to `after_task_id` (or the head
 * when it is `null`, or the tail when omitted).
 */
export const planRevisionOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_title"), title: z.string().min(1).max(MAX_PLAN_TITLE_CHARS) }),
  z.object({
    type: z.literal("set_objective"),
    objective: z.string().max(MAX_PLAN_SECTION_CHARS),
  }),
  z.object({
    type: z.literal("set_context"),
    context: z.string().max(MAX_PLAN_SECTION_CHARS),
  }),
  z.object({
    type: z.literal("add_task"),
    task: taskContentSchema,
    after_task_id: z
      .string()
      .regex(/^t[1-9]\d*$/)
      .optional(),
  }),
  z.object({
    type: z.literal("edit_task"),
    task_id: z.string().regex(/^t[1-9]\d*$/),
    task: taskContentSchema.partial().refine((value) => Object.keys(value).length > 0),
  }),
  z.object({ type: z.literal("remove_task"), task_id: z.string().regex(/^t[1-9]\d*$/) }),
  z.object({
    type: z.literal("reorder_task"),
    task_id: z.string().regex(/^t[1-9]\d*$/),
    after_task_id: z
      .string()
      .regex(/^t[1-9]\d*$/)
      .nullable(),
  }),
  z.object({
    type: z.literal("set_validation"),
    validation: z.array(singleLineSchema).max(MAX_PLAN_VALIDATION_ITEMS),
  }),
]);

/** A single structural edit to a plan. @see {@link planRevisionOperationSchema} */
export type PlanRevisionOperation = z.infer<typeof planRevisionOperationSchema>;

/**
 * Advance a mutated plan to its next revision.
 *
 * @param current - the document as it was last read.
 * @param changed - the same document after the caller's edit.
 * @param options - `structural` marks an edit to the plan's *substance*, which
 *   also bumps `spec_revision` and clears any `approved_spec_revision`; `now`
 *   stamps `updated_at`.
 * @returns the next document, with both digests blanked for recomputation from
 *   the rendered bytes.
 * @remarks `id` and `path` are pinned from `current`: a mutation may never
 *   relocate or re-identify the plan it is editing.
 *
 *   A structural edit that revokes an existing approval also returns the plan to
 *   `awaiting_approval`, so the document reports the same thing the runtime
 *   enforces. Clearing `approved_spec_revision` while leaving `status: active`
 *   showed the model a plan that claimed to be active while every tool answered
 *   "blocked while the plan is awaiting approval". The reset is conditioned on
 *   `current.approved_spec_revision` being set — which only a review run ever
 *   does — so a plan running under `plans: "on"` is never moved into a state its
 *   run has no gate to leave.
 */
export function nextRevision(
  current: PlanDocument,
  changed: PlanDocument,
  options: { structural: boolean; now: Date },
): PlanDocument {
  const revokesApproval = options.structural && current.approved_spec_revision !== undefined;
  return {
    ...changed,
    id: current.id,
    ...(current.path === undefined ? {} : { path: current.path }),
    revision: current.revision + 1,
    spec_revision: current.spec_revision + (options.structural ? 1 : 0),
    ...(options.structural ? { approved_spec_revision: undefined } : {}),
    ...(revokesApproval ? { status: "awaiting_approval" as const } : {}),
    updated_at: options.now.toISOString(),
    digest: "",
    spec_digest: "",
  };
}

/**
 * Fold a batch of {@link PlanRevisionOperation}s onto a plan in order, returning
 * one new document (the input is never mutated).
 *
 * @param document - the plan to revise.
 * @param operations - the edits, applied left to right; each sees the result of
 *   the one before it, so an `add_task` may be referenced by a later
 *   `reorder_task`.
 * @returns the revised `document`, and `structural` — true when *any* operation
 *   was structural, which is what makes the batch cost a single `spec_revision`.
 * @throws {@link Error} propagated from {@link applyPlanRevision}; the caller is
 *   left holding the untouched input, so a batch is all-or-nothing.
 *
 * @remarks Batching exists because compare-and-swap makes plan edits strictly
 *   serial otherwise. A caller holds exactly one CAS triple, so every call it
 *   issues from one decision carries that same triple: the first write moves the
 *   plan on and every other one fails the compare-and-swap check. Measured on a
 *   three-operation batch, one applied and two were rejected. The cost fell on
 *   the model, which had to spend a whole round trip per edit — a plan in the
 *   demo workspace reached `revision: 35` that way.
 */
export function applyPlanRevisions(
  document: PlanDocument,
  operations: readonly PlanRevisionOperation[],
): { document: PlanDocument; structural: boolean } {
  if (operations.length > MAX_PLAN_BATCH_OPERATIONS)
    throw new RangeError(`Plan revision batch exceeds ${MAX_PLAN_BATCH_OPERATIONS} operations`);
  let next = document;
  let structural = false;
  for (const operation of operations) {
    const applied = applyPlanRevision(next, operation);
    next = applied.document;
    structural ||= applied.structural;
  }
  return { document: next, structural };
}

function taskIndex(tasks: PlanTask[], id: string): number {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Unknown plan task: ${id}`);
  return index;
}

/**
 * Apply one {@link PlanRevisionOperation} to a plan, returning a new document
 * (the input is never mutated) plus whether the edit was structural.
 *
 * @param document - the plan to revise.
 * @param operationInput - the operation to apply; re-validated against
 *   {@link planRevisionOperationSchema}.
 * @returns the revised `document` and `structural`, which is `false` only for
 *   `set_title` (a metadata change that preserves a spec approval) and `true`
 *   for every operation that changes the plan's substance.
 * @throws {@link Error} if a referenced task id does not exist, or a task is
 *   reordered after itself.
 */
export function applyPlanRevision(
  document: PlanDocument,
  operationInput: PlanRevisionOperation,
): { document: PlanDocument; structural: boolean } {
  const operation = planRevisionOperationSchema.parse(operationInput);
  const next = structuredClone(document);
  switch (operation.type) {
    case "set_title":
      next.title = operation.title;
      return { document: next, structural: false };
    case "set_objective":
      next.objective = operation.objective;
      break;
    case "set_context":
      next.context = operation.context;
      break;
    case "add_task": {
      const numericIds = next.tasks.map((task) => Number(task.id.slice(1)));
      const task: PlanTask = {
        id: `t${Math.max(0, ...numericIds) + 1}`,
        status: "pending",
        ...operation.task,
      };
      const index =
        operation.after_task_id === undefined
          ? next.tasks.length
          : taskIndex(next.tasks, operation.after_task_id) + 1;
      next.tasks.splice(index, 0, task);
      break;
    }
    case "edit_task":
      Object.assign(next.tasks[taskIndex(next.tasks, operation.task_id)]!, operation.task);
      break;
    case "remove_task":
      next.tasks.splice(taskIndex(next.tasks, operation.task_id), 1);
      break;
    case "reorder_task": {
      const [task] = next.tasks.splice(taskIndex(next.tasks, operation.task_id), 1);
      if (operation.after_task_id === operation.task_id)
        throw new Error("A task cannot be ordered after itself");
      const index =
        operation.after_task_id === null ? 0 : taskIndex(next.tasks, operation.after_task_id) + 1;
      next.tasks.splice(index, 0, task!);
      break;
    }
    case "set_validation":
      next.validation = operation.validation;
      break;
  }
  return { document: next, structural: true };
}
