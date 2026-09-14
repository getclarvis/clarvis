import { z } from "zod";
import { workflowFrontmatterSchema, type WorkflowDefinition } from "@clarvis/workflows/artifact";
import { WORKFLOW_LIMITS } from "@clarvis/workflows/schemas";

const text = z.string().min(1).max(WORKFLOW_LIMITS.pathChars);
const filter = z
  .object({ field: text, equals: z.union([z.string(), z.number(), z.boolean()]).optional() })
  .strict();
const selector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }).strict(),
  z.object({ kind: z.literal("all"), source: text }).strict(),
  z.object({ kind: z.literal("each"), source: text, where: filter.optional() }).strict(),
]);
const accept = z.union([
  z.object({ kind: z.enum(["all", "any", "majority"]), field: text, value: text }).strict(),
  z
    .object({
      kind: z.literal("threshold"),
      field: text,
      value: text,
      count: z.number().int().positive(),
    })
    .strict(),
]);
const native = workflowFrontmatterSchema.shape;
const round = native.rounds.element
  .omit({ over: true, brief: true, accept: true })
  .extend({
    over: selector,
    brief: z.string().max(WORKFLOW_LIMITS.textChars),
    fanout: native.rounds.element.shape.fanout.unwrap(),
    accept: accept.optional(),
  })
  .strict();

/** Resolved native workflow data, with no loader path and no extension origin. */
export const containerWorkflowSchema = z
  .object({
    name: native.name,
    description: native.description,
    args: native.args.unwrap(),
    rounds: z.array(round).min(1).max(WORKFLOW_LIMITS.rounds),
    repeat: native.repeat.unwrap().strict().optional(),
    synthesis: z.string().max(WORKFLOW_LIMITS.textChars),
    origin: z.enum(["builtin", "global", "workspace"]),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const ids = new Set(definition.rounds.map((item) => item.id));
    if (
      ids.size !== definition.rounds.length ||
      definition.rounds[0]?.over.kind !== "once" ||
      definition.repeat?.rounds.some((id) => !ids.has(id))
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid native workflow round graph" });
    }
  });

/** Already resolved host definitions; this port never discovers files or plugins. */
export interface ContainerWorkflowInput {
  origin: "builtin" | "global" | "workspace";
  definition: WorkflowDefinition;
}

/** Remove diagnostic paths and resolve native layer precedence without consulting a loader. */
export function projectContainerWorkflows(
  inputs: readonly ContainerWorkflowInput[],
): z.infer<typeof containerWorkflowSchema>[] {
  const rank = { builtin: 0, global: 1, workspace: 2 };
  const winners = new Map<string, z.infer<typeof containerWorkflowSchema>>();
  for (const input of inputs) {
    const d = input.definition;
    const value = containerWorkflowSchema.parse({
      name: d.name,
      description: d.description,
      args: d.args,
      rounds: d.rounds,
      ...(d.repeat === undefined ? {} : { repeat: d.repeat }),
      synthesis: d.synthesis,
      origin: input.origin,
    });
    const old = winners.get(value.name);
    if (old === undefined || rank[value.origin] >= rank[old.origin]) winners.set(value.name, value);
  }
  return [...winners.values()];
}
