import { z } from "zod";
import {
  MAX_PLAN_ASSIGNEE_CHARS,
  MAX_PLAN_EXTENSION_FIELDS,
  MAX_PLAN_EXTENSION_KEY_CHARS,
  MAX_PLAN_LOCATOR_CHARS,
  MAX_PLAN_SECTION_CHARS,
  MAX_PLAN_TASK_FIELD_CHARS,
  MAX_PLAN_TASKS,
  MAX_PLAN_TASK_TITLE_CHARS,
  MAX_PLAN_TEXT_CHARS,
  MAX_PLAN_TITLE_CHARS,
  MAX_PLAN_VALIDATION_ITEM_CHARS,
  MAX_PLAN_VALIDATION_ITEMS,
} from "./limits.ts";

/**
 * Lifecycle status of a whole plan.
 *
 * `awaiting_approval` is the initial status in review mode; `active` is the
 * working status; `completed`, `cancelled`, and `failed` are the terminal
 * statuses a run's finalization records.
 */
export const planStatusSchema = z.enum([
  "awaiting_approval",
  "active",
  "completed",
  "cancelled",
  "failed",
]);

/**
 * What happens to the plan file when its run reaches a successful terminal
 * state: `keep` (the default) leaves it as workspace history, `discard` deletes
 * it. A crash or cancellation never deletes.
 */
export const planRetentionSchema = z.enum(["discard", "keep"]);

/**
 * The product default retention: never delete a plan the user did not
 * explicitly ask to have deleted. Every layer that has to invent a retention —
 * {@link newPlan}, the loop's `plans` settings block, the kernel's run-request
 * assembler — resolves to this value, so a forgotten hand-off can only ever
 * fail safe.
 */
export const DEFAULT_PLAN_RETENTION = "keep" as const satisfies z.infer<typeof planRetentionSchema>;

/**
 * Status of a single task. See {@link allowedTaskTransitions} for the legal
 * transitions between these and {@link transitionTask} for the outcome fields
 * each terminal status requires.
 *
 * @remarks
 * `returned` is a sub-agent's hand-back that still awaits the lead's judgment —
 * it is not a closed state. Only `done` and `abandoned` close a task.
 */
export const planTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "returned",
  "done",
  "abandoned",
  "failed",
]);

/**
 * A task title rides the `- [x] (t1) <title>` marker line, and a validation item
 * rides a `- <item>` line — both are single-line by construction. A newline (or a
 * blank title) would render into an unparseable document, so reject it at the
 * boundary. Free-form task fields (detail/result/error/…) and prose sections stay
 * multi-line — the renderer/parser handle those.
 */
export const taskTitleSchema = z
  .string()
  .max(MAX_PLAN_TASK_TITLE_CHARS)
  .refine((value) => value.trim().length > 0 && !value.includes("\n"), {
    message: "must be a non-empty single line",
  });
export const singleLineSchema = z
  .string()
  .max(MAX_PLAN_VALIDATION_ITEM_CHARS)
  .refine((value) => !value.includes("\n"), { message: "must be a single line" });

/**
 * One task in a plan.
 *
 * @remarks
 * `id` is stable for the life of the plan and matches `t` followed by a positive
 * integer (`t1`, `t2`, …). `title` is single-line (see {@link taskTitleSchema});
 * `detail`, `exit`, `result`, `error`, and `reason` are free-form and may span
 * multiple lines. `result`/`error`/`reason` are the outcome fields written when
 * the task reaches `done`/`failed`/`abandoned` respectively.
 */
export const planTaskSchema = z.object({
  id: z
    .string()
    .max(32)
    .regex(/^t[1-9]\d*$/),
  title: taskTitleSchema,
  status: planTaskStatusSchema,
  detail: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  exit: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  assignee: z.string().max(MAX_PLAN_ASSIGNEE_CHARS).optional(),
  result: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  error: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  reason: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
});

const unknownFrontmatterSchema = z
  .record(z.string().max(MAX_PLAN_EXTENSION_KEY_CHARS), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_PLAN_EXTENSION_FIELDS, {
    message: `must contain at most ${MAX_PLAN_EXTENSION_FIELDS} keys`,
  });

const extraSectionsSchema = z
  .record(z.string().max(MAX_PLAN_EXTENSION_KEY_CHARS), z.string().max(MAX_PLAN_SECTION_CHARS))
  .refine((value) => Object.keys(value).length <= MAX_PLAN_EXTENSION_FIELDS, {
    message: `must contain at most ${MAX_PLAN_EXTENSION_FIELDS} sections`,
  });

/**
 * The full parsed plan.
 *
 * @remarks
 * `revision` counts every write; `spec_revision` counts only changes to the
 * plan's *substance* (objective/context/tasks/validation), so recording task
 * progress never invalidates a human approval bound to `approved_spec_revision`.
 * `digest` and `spec_digest` are the compare-and-swap fingerprints (see
 * {@link PlanCas}). `unknown_frontmatter` and `extra_sections` capture
 * human/tool-authored content the format does not control but round-trips
 * verbatim.
 */
export const planDocumentSchema = z
  .object({
    /** Display locator supplied by the repository (the file path, for the
     * file-backed adapter). Never persisted in the document itself — the identity
     * is `id`. */
    path: z.string().max(MAX_PLAN_LOCATOR_CHARS).optional(),
    id: z.string().min(1).max(MAX_PLAN_LOCATOR_CHARS),
    title: z.string().min(1).max(MAX_PLAN_TITLE_CHARS),
    status: planStatusSchema,
    retention: planRetentionSchema,
    revision: z.number().int().nonnegative(),
    spec_revision: z.number().int().nonnegative(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    created_by_run: z.string().min(1).max(MAX_PLAN_LOCATOR_CHARS),
    approved_spec_revision: z.number().int().nonnegative().optional(),
    objective: z.string().max(MAX_PLAN_SECTION_CHARS),
    context: z.string().max(MAX_PLAN_SECTION_CHARS),
    tasks: z.array(planTaskSchema).max(MAX_PLAN_TASKS),
    validation: z.array(singleLineSchema).max(MAX_PLAN_VALIDATION_ITEMS),
    notes: z.string().max(MAX_PLAN_SECTION_CHARS),
    unknown_frontmatter: unknownFrontmatterSchema.default({}),
    extra_sections: extraSectionsSchema.default({}),
    digest: z.string().max(256),
    spec_digest: z.string().max(256),
  })
  .superRefine((document, ctx) => {
    let textChars =
      document.title.length +
      document.objective.length +
      document.context.length +
      document.notes.length;
    for (const task of document.tasks) {
      textChars += task.title.length;
      for (const value of [
        task.detail,
        task.exit,
        task.assignee,
        task.result,
        task.error,
        task.reason,
      ])
        textChars += value?.length ?? 0;
    }
    for (const item of document.validation) textChars += item.length;
    for (const [name, value] of Object.entries(document.extra_sections))
      textChars += name.length + value.length;
    if (textChars > MAX_PLAN_TEXT_CHARS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `controlled plan text exceeds ${MAX_PLAN_TEXT_CHARS} characters`,
      });
  });

/** Lifecycle status of a whole plan. @see {@link planStatusSchema} */
export type PlanStatus = z.infer<typeof planStatusSchema>;
/** File retention policy for a plan. @see {@link planRetentionSchema} */
export type PlanRetention = z.infer<typeof planRetentionSchema>;
/** Status of a single task. @see {@link planTaskStatusSchema} */
export type PlanTaskStatus = z.infer<typeof planTaskStatusSchema>;
/** One task in a plan. @see {@link planTaskSchema} */
export type PlanTask = z.infer<typeof planTaskSchema>;
/** The full parsed plan. @see {@link planDocumentSchema} */
export type PlanDocument = z.infer<typeof planDocumentSchema>;

/**
 * A pointer from a run record to the provider-owned plan it produced, so a client
 * can read the document back through the plans service.
 *
 * @remarks `provider_key` and `id` are the identity; optional `path` is display-only.
 * `final_revision`/`final_spec_revision` capture
 * the plan's CAS revisions at run end; `status` and `retention` mirror the plan's
 * terminal lifecycle. The plan document itself is deliberately not in the run
 * trace.
 *
 * This is what the planning capability files under its own name in
 * `ExecutionRecord.capability_state`. It used to live in `@clarvis/capability` as
 * a typed `plan_ref` field on the record, which made one feature's bookkeeping
 * part of the engine's persistence contract.
 */
export interface PlanRef {
  /** The plan's stable identity, used to re-attach it on a continued run. */
  id: string;
  /** Stable identity of the provider that owns `id`. */
  provider_key: string;
  /** Display locator when the backend has one (the file path). */
  path?: string;
  final_revision: number;
  final_spec_revision: number;
  status: "awaiting_approval" | "active" | "completed" | "cancelled" | "failed";
  retention: "discard" | "keep";
}

/**
 * The planning capability's registry name.
 *
 * @remarks The single owner: the `plans` settings block moved into this
 * package (`./settings.ts`), so nothing outside it spells the name. The kernel
 * imports this constant rather than restating it, both to register the
 * capability and to find its slot in a run's `capability_state`.
 */
export const PLANS_CAPABILITY_NAME = "plans";
