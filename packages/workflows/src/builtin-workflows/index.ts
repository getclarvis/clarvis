import type { WorkflowDefinition } from "../artifact.ts";
import { AUDIT_WORKFLOW } from "./audit.ts";
import { IMPLEMENT_WORKFLOW } from "./implement.ts";
import { RESEARCH_WORKFLOW } from "./research.ts";

/** The workflow definitions Clarvis ships as code, in presentation order. */
export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [
  AUDIT_WORKFLOW,
  IMPLEMENT_WORKFLOW,
  RESEARCH_WORKFLOW,
];

/** The built-in workflow names, derived from the definitions they identify. */
export const BUILTIN_WORKFLOW_NAMES: readonly string[] = BUILTIN_WORKFLOWS.map(
  (workflow) => workflow.name,
);

/** Apply operator-authored definitions over the workflows shipped by Clarvis. */
export function resolveWorkflowDefinitions(
  overrides: readonly WorkflowDefinition[],
): readonly WorkflowDefinition[] {
  const byName = new Map(BUILTIN_WORKFLOWS.map((workflow) => [workflow.name, workflow]));
  for (const workflow of overrides) byName.set(workflow.name, workflow);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
