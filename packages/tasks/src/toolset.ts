import type { NamespacedTool, ToolEffect } from "@clarvis/capability";
import { z } from "zod";
import {
  TASK_LIMITS,
  taskArtifactSchema,
  taskIdentifierSchema,
  taskStageSchema,
  zodTaskInputSchema,
} from "./schemas.ts";

export const TASK_GRANTS = Object.freeze({
  read: "tasks.read",
  create: "tasks.create",
  assign: "tasks.assign",
  comment: "tasks.comment",
  progress: "tasks.progress",
  review: "tasks.review",
  complete: "tasks.complete",
});

export const TASK_TOOL_NAMES = Object.freeze({
  list: "list_tasks",
  read: "read_task",
  create: "create_task",
  assign: "assign_task",
  comment: "comment_task",
  start: "start_task",
  block: "block_task",
  review: "submit_task_for_review",
  complete: "complete_task",
  reopen: "reopen_task",
});

const id = taskIdentifierSchema;
const reason = z.string().trim().min(1).max(TASK_LIMITS.reason);
const optionalRef = { id: id.optional() };

export const taskToolInputSchemas = {
  [TASK_TOOL_NAMES.list]: z
    .object({
      container_id: id.optional(),
      query: z.string().max(TASK_LIMITS.query).optional(),
      stages: z.array(taskStageSchema).max(8).optional(),
      assignee_id: id.optional(),
      labels: z.array(z.string().max(TASK_LIMITS.label)).max(TASK_LIMITS.labels).optional(),
      claim: z.enum(["any", "free", "claimed"]).optional(),
      updated_after: z.string().datetime({ offset: true }).optional(),
      cursor: z.string().max(TASK_LIMITS.cursor).optional(),
      limit: z.number().int().min(1).max(TASK_LIMITS.pageMax).optional(),
    })
    .strict(),
  [TASK_TOOL_NAMES.read]: z.object({ id }).strict(),
  [TASK_TOOL_NAMES.create]: z
    .object({
      container_id: id.optional(),
      title: z.string().trim().min(1).max(TASK_LIMITS.title),
      description: z.string().max(TASK_LIMITS.description).optional(),
      acceptance_criteria: z
        .array(z.string().max(TASK_LIMITS.criterion))
        .max(TASK_LIMITS.criteria)
        .optional(),
      priority: z.string().max(TASK_LIMITS.label).optional(),
      assignee_id: id.optional(),
      labels: z.array(z.string().max(TASK_LIMITS.label)).max(TASK_LIMITS.labels).optional(),
    })
    .strict(),
  [TASK_TOOL_NAMES.assign]: z.object({ ...optionalRef, assignee_id: id.nullable() }).strict(),
  [TASK_TOOL_NAMES.comment]: z
    .object({
      ...optionalRef,
      body: z.string().trim().min(1).max(TASK_LIMITS.comment),
    })
    .strict(),
  [TASK_TOOL_NAMES.start]: z.object({}).strict(),
  [TASK_TOOL_NAMES.block]: z.object({ reason }).strict(),
  [TASK_TOOL_NAMES.review]: z
    .object({
      summary: z.string().trim().min(1).max(TASK_LIMITS.summary),
      evidence: z
        .array(z.string().trim().min(1).max(TASK_LIMITS.evidenceItem))
        .max(TASK_LIMITS.evidence)
        .optional(),
      artifacts: z.array(taskArtifactSchema).max(TASK_LIMITS.artifacts).optional(),
      no_evidence_reason: reason.optional(),
      allow_without_artifacts: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.evidence?.length ?? 0) > 0 ||
        (value.artifacts?.length ?? 0) > 0 ||
        value.no_evidence_reason !== undefined,
      { message: "provide evidence, an artifact, or no_evidence_reason" },
    ),
  [TASK_TOOL_NAMES.complete]: z.object({ reason: reason.optional() }).strict(),
  [TASK_TOOL_NAMES.reopen]: z.object({ reason: reason.optional() }).strict(),
} as const;

const descriptions: Record<(typeof TASK_TOOL_NAMES)[keyof typeof TASK_TOOL_NAMES], string> = {
  list_tasks:
    "Search the selected external task provider with normalized filters and opaque pagination.",
  read_task: "Read one task from the selected provider by its native stable id.",
  create_task: "Create a task in an explicit or configured default container.",
  assign_task: "Assign or unassign an explicit task, or the active task when id is omitted.",
  comment_task: "Add a comment to an explicit task, or the active task when id is omitted.",
  start_task:
    "Explicitly start work on the active task and claim it when the provider enforces claims.",
  block_task: "Mark the active task blocked with a reason.",
  submit_task_for_review:
    "Publish a summary and evidence, then transition the active task to review.",
  complete_task:
    "Explicitly complete the active task. Run completion never calls this automatically.",
  reopen_task: "Explicitly reopen the active task.",
};

function descriptor(name: keyof typeof taskToolInputSchemas): NamespacedTool {
  return {
    fullName: `clarvis.tasks.${name}`,
    wireName: name,
    mcpName: "clarvis",
    toolName: name,
    description: descriptions[name],
    inputSchema: zodTaskInputSchema(taskToolInputSchemas[name]),
  };
}

export const TASK_TOOLS = Object.fromEntries(
  Object.values(TASK_TOOL_NAMES).map((name) => [name, descriptor(name)]),
) as Record<(typeof TASK_TOOL_NAMES)[keyof typeof TASK_TOOL_NAMES], NamespacedTool>;

export const TASK_TOOL_WIRE_NAMES = Object.values(TASK_TOOL_NAMES);
export const TASK_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  TASK_TOOL_WIRE_NAMES.map((name) => [
    name,
    name === TASK_TOOL_NAMES.list || name === TASK_TOOL_NAMES.read ? "read" : "mutate",
  ]),
);
