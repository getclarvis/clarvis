/** Wire name of the tool that creates the active workspace plan. */
export const CREATE_PLAN_TOOL_NAME = "create_plan";
/** Wire name of the tool that reads the active plan or a historical one. */
export const READ_PLAN_TOOL_NAME = "read_plan";
/** Wire name of the tool that lists workspace plan history. */
export const LIST_PLANS_TOOL_NAME = "list_plans";
/** Wire name of the tool that applies one structural plan revision. */
export const REVISE_PLAN_TOOL_NAME = "revise_plan";
/** Wire name of the tool that transitions one task and records its outcome. */
export const TRANSITION_PLAN_TASK_TOOL_NAME = "transition_plan_task";

import { z } from "zod";
import {
  MAX_PLAN_ASSIGNEE_CHARS,
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_LOCATOR_CHARS,
  MAX_PLAN_SECTION_CHARS,
  MAX_PLAN_TASK_FIELD_CHARS,
  MAX_PLAN_TASKS,
  MAX_PLAN_TASK_TITLE_CHARS,
  MAX_PLAN_TITLE_CHARS,
  MAX_PLAN_VALIDATION_ITEM_CHARS,
  MAX_PLAN_VALIDATION_ITEMS,
} from "./limits.ts";
import { planRevisionOperationSchema } from "./revisions.ts";

/** An explicit null means an omitted read filter, without admitting empty or invalid values. */
function optionalQueryField<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

/** Read the current plan when the model omits its id or supplies the advertised null alternative. */
export const readPlanInputSchema = z.object({
  id: optionalQueryField(z.string().min(1).max(MAX_PLAN_LOCATOR_CHARS)),
});

/** Normalize explicit absent paging/filter options before crossing the provider's typed list port. */
export const listPlansInputSchema = z.object({
  cursor: optionalQueryField(z.string().min(1).max(MAX_PLAN_LOCATOR_CHARS)),
  limit: optionalQueryField(z.number().int().min(1).max(100)),
  status: optionalQueryField(
    z.enum(["awaiting_approval", "active", "completed", "cancelled", "failed"]),
  ),
  retention: optionalQueryField(z.enum(["discard", "keep"])),
});

/**
 * Validation schema for {@link REVISE_PLAN_TOOL_NAME} arguments: the
 * compare-and-swap triple (`expected_revision`/`expected_digest`/
 * `expected_spec_digest`) plus the
 * {@link planRevisionOperationSchema | operations} to apply. Parsing normalises
 * either accepted shape to an `operations` array.
 *
 * @remarks The advertised shape is the batch, because compare-and-swap makes a
 *   second call from the same decision impossible: it would carry the triple the
 *   first one just invalidated. The singular `operation` is still accepted — a
 *   model that reaches for it is not wrong about the plan, only about the
 *   envelope, and rejecting that costs a whole round trip to learn nothing.
 */
export const revisePlanInputSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    expected_digest: z.string().min(1).max(256),
    expected_spec_digest: z.string().min(1).max(256),
    operations: z
      .array(planRevisionOperationSchema)
      .min(1)
      .max(MAX_PLAN_BATCH_OPERATIONS)
      .optional(),
    operation: planRevisionOperationSchema.optional(),
  })
  .refine((value) => (value.operations === undefined) !== (value.operation === undefined), {
    message: "Pass either `operations` (preferred, a batch) or a single `operation`, not both",
  })
  .transform(({ operation, operations, ...cas }) => ({
    ...cas,
    operations: operations ?? [operation!],
  }));

/**
 * The JSON-Schema tool definitions (name, description, `inputSchema`) exposed to
 * a model host for the five plan tools. These definitions are the wire contract
 * advertised to the model; a host's runtime validates the actual arguments
 * separately.
 *
 * @remarks Read/list catalogs are generated from their shared input schemas;
 *   the runtime normalizes their null alternatives before invoking the provider.
 *   Revision validation also lives here. Create and transition validation remain
 *   in `capability/runtime-tools.ts`; edits must keep their advertised bounds aligned.
 */
export const planToolDefinitions = [
  {
    name: CREATE_PLAN_TOOL_NAME,
    description:
      "Create the active plan. Only one may have open tasks: use revise_plan to change it and " +
      "transition_plan_task to record progress. Once all tasks close, create a new plan for new " +
      "work; completed plans cannot be revised.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "tasks", "validation"],
      properties: {
        title: { type: "string", maxLength: MAX_PLAN_TITLE_CHARS },
        objective: { type: "string", maxLength: MAX_PLAN_SECTION_CHARS },
        context: { type: "string", maxLength: MAX_PLAN_SECTION_CHARS },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_TASKS,
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string", maxLength: MAX_PLAN_TASK_TITLE_CHARS },
              detail: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
              exit: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
            },
          },
        },
        validation: {
          type: "array",
          maxItems: MAX_PLAN_VALIDATION_ITEMS,
          items: { type: "string", maxLength: MAX_PLAN_VALIDATION_ITEM_CHARS },
        },
        retention: { enum: ["discard", "keep"] },
      },
    },
  },
  {
    name: READ_PLAN_TOOL_NAME,
    description:
      "Read the active plan (omit id or pass null) or a historical plan by stable id, including its current revision and digests. Never pass an empty id.",
    inputSchema: z.toJSONSchema(readPlanInputSchema, { target: "draft-7", io: "input" }),
  },
  {
    name: LIST_PLANS_TOOL_NAME,
    description:
      "List workspace plan history. Omit cursor or pass null for the first page; use only a returned cursor for another page. Omit or pass null for the default limit and unfiltered status/retention.",
    inputSchema: z.toJSONSchema(listPlansInputSchema, { target: "draft-7", io: "input" }),
  },
  {
    name: REVISE_PLAN_TOOL_NAME,
    description:
      "Revise the active plan with one ordered, atomic operations batch. Copy revision, digest " +
      "and spec_digest from current plan state into expected_*; never guess. Each mutation " +
      "invalidates that triple: do not parallelize plan mutations. On conflict, read_plan and " +
      "reassess the edits before retrying. Structural changes require renewed approval in review mode.",
    inputSchema: {
      type: "object",
      required: ["expected_revision", "expected_digest", "expected_spec_digest", "operations"],
      properties: {
        expected_revision: { type: "integer", minimum: 1 },
        expected_digest: { type: "string", maxLength: 256 },
        expected_spec_digest: { type: "string", maxLength: 256 },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_BATCH_OPERATIONS,
          items: {
            oneOf: [
              {
                type: "object",
                required: ["type", "title"],
                properties: {
                  type: { const: "set_title" },
                  title: { type: "string", maxLength: MAX_PLAN_TITLE_CHARS },
                },
              },
              {
                type: "object",
                required: ["type", "objective"],
                properties: {
                  type: { const: "set_objective" },
                  objective: { type: "string", maxLength: MAX_PLAN_SECTION_CHARS },
                },
              },
              {
                type: "object",
                required: ["type", "context"],
                properties: {
                  type: { const: "set_context" },
                  context: { type: "string", maxLength: MAX_PLAN_SECTION_CHARS },
                },
              },
              {
                type: "object",
                required: ["type", "task"],
                properties: {
                  type: { const: "add_task" },
                  task: {
                    type: "object",
                    properties: {
                      title: { type: "string", maxLength: MAX_PLAN_TASK_TITLE_CHARS },
                      detail: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
                      exit: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
                    },
                  },
                  after_task_id: { type: "string", maxLength: 32 },
                },
              },
              {
                type: "object",
                required: ["type", "task_id", "task"],
                properties: {
                  type: { const: "edit_task" },
                  task_id: { type: "string", maxLength: 32 },
                  task: {
                    type: "object",
                    properties: {
                      title: { type: "string", maxLength: MAX_PLAN_TASK_TITLE_CHARS },
                      detail: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
                      exit: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
                    },
                  },
                },
              },
              {
                type: "object",
                required: ["type", "task_id"],
                properties: {
                  type: { const: "remove_task" },
                  task_id: { type: "string", maxLength: 32 },
                },
              },
              {
                type: "object",
                required: ["type", "task_id", "after_task_id"],
                properties: {
                  type: { const: "reorder_task" },
                  task_id: { type: "string", maxLength: 32 },
                  after_task_id: { type: ["string", "null"], maxLength: 32 },
                },
              },
              {
                type: "object",
                required: ["type", "validation"],
                properties: {
                  type: { const: "set_validation" },
                  validation: {
                    type: "array",
                    maxItems: MAX_PLAN_VALIDATION_ITEMS,
                    items: { type: "string", maxLength: MAX_PLAN_VALIDATION_ITEM_CHARS },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
  {
    name: TRANSITION_PLAN_TASK_TOOL_NAME,
    description:
      "Record task outcomes in one ordered, atomic transitions batch. Copy current revision, " +
      "digest and spec_digest into expected_*; do not parallelize plan mutations. On conflict, " +
      "read_plan before retrying. Only done (requires result) and abandoned (requires reason) " +
      "close tasks; returned and failed (requires error) remain open. Review delegated work before done.",
    inputSchema: {
      type: "object",
      required: ["expected_revision", "expected_digest", "expected_spec_digest", "transitions"],
      properties: {
        expected_revision: { type: "integer", minimum: 1 },
        expected_digest: { type: "string", maxLength: 256 },
        expected_spec_digest: { type: "string", maxLength: 256 },
        transitions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_BATCH_OPERATIONS,
          items: {
            type: "object",
            required: ["task_id", "status"],
            properties: {
              task_id: { type: "string", maxLength: 32 },
              status: {
                enum: ["pending", "in_progress", "returned", "done", "abandoned", "failed"],
              },
              result: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
              error: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
              reason: { type: "string", maxLength: MAX_PLAN_TASK_FIELD_CHARS },
              assignee: { type: "string", maxLength: MAX_PLAN_ASSIGNEE_CHARS },
            },
          },
        },
      },
    },
  },
] as const;
