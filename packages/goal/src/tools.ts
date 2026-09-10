import type { NamespacedTool } from "@clarvis/capability";
import { z } from "zod";
import { goalModelToolInputSchema } from "./model-input.ts";

export const GET_GOAL = "get_goal";
export const UPDATE_GOAL = "update_goal";
export const getGoalInputSchema = z.object({}).strict();

/** Stable names, schemas and order; goal revisions, permissions and balances never alter the catalog. */
export function buildGoalTools(): NamespacedTool[] {
  return [
    {
      fullName: GET_GOAL,
      wireName: GET_GOAL,
      toolName: GET_GOAL,
      mcpName: "",
      description:
        "Read the bound objective, current criteria, progress, limits and host-issued evidence IDs. " +
        "The host owns scope and continuation. Reading or rewording progress does not prove useful work.",
      inputSchema: z.toJSONSchema(getGoalInputSchema, { target: "draft-7", io: "input" }),
    },
    {
      fullName: UPDATE_GOAL,
      wireName: UPDATE_GOAL,
      toolName: UPDATE_GOAL,
      mcpName: "",
      description:
        "Pass one update object for the bound goal, choosing only its action's fields. " +
        "Progress requires summary and optional evidence_ids; " +
        "checkpoint also requires next_step and requests a stage ending through all gates. " +
        "Candidate requires summary and assessments covering every current criterion, with " +
        "criterion_id, kind, justification and optional host-issued evidence_ids; then deliver " +
        "the normal final result. It does not commit completion. Blocked requires reason and " +
        "stops safely for user intervention. Only the user may edit, resume or increase limits.",
      inputSchema: z.toJSONSchema(goalModelToolInputSchema, { target: "draft-7", io: "input" }),
    },
  ];
}
