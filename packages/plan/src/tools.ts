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
 * @remarks {@link revisePlanInputSchema} above is this package's only exported
 *   Zod schema, and it is the one `capability/runtime-tools.ts` imports to
 *   validate `revise_plan` arguments with. The other four tools' argument
 *   validation is a separate set of Zod schemas local to that same file. Both
 *   halves live inside this package: the wire contract advertised here and the
 *   validation applied there travel together, so a schema change cannot reach a
 *   model without its validator.
 */
export const planToolDefinitions = [
  {
    name: CREATE_PLAN_TOOL_NAME,
    description:
      "Create a plan for the work in front of you. Only one plan may be open at a time, so this " +
      "fails while the current plan still has open tasks — to change that plan use revise_plan, " +
      "and to record a task's progress use transition_plan_task. Once every task is closed the " +
      "plan is finished: call this again for the next piece of work rather than rewriting the " +
      "finished one, which is a completed record and can no longer be revised.",
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
    description: "Read the active plan or a historical plan by stable id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", maxLength: MAX_PLAN_LOCATOR_CHARS } },
    },
  },
  {
    name: LIST_PLANS_TOOL_NAME,
    description: "List workspace plan history.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", maxLength: MAX_PLAN_LOCATOR_CHARS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        status: {
          enum: ["awaiting_approval", "active", "completed", "cancelled", "failed"],
        },
        retention: { enum: ["discard", "keep"] },
      },
    },
  },
  {
    name: REVISE_PLAN_TOOL_NAME,
    description:
      "Apply structural plan revisions with compare-and-swap. Pass every edit you want in one " +
      "call: `operations` is applied in order, all-or-nothing, and costs one revision. Do not " +
      "split them across calls in the same turn — each call invalidates the compare-and-swap " +
      "triple, so the second would be rejected as a conflict.",
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
      "Transition plan tasks and record their outcomes, with compare-and-swap. Pass every task " +
      "you are moving in one call: `transitions` is applied in order, all-or-nothing, and costs " +
      "one revision. Do not split them across calls in the same turn — each call invalidates the " +
      "compare-and-swap triple, so the second would be rejected as a conflict. `done` requires " +
      "`result`, `failed` requires `error`, `abandoned` requires `reason`.",
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
