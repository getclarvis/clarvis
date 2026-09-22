import type { GoalRuntimeSnapshot } from "./ports.ts";

export const GOAL_BLOCK_KIND = "goal";
export const GOAL_FORMULATION_BLOCK_KIND = "goal_formulation";

/** Host instruction appended after the operator request; it is not the operator's words. */
export const GOAL_FORMULATION_INSTRUCTION = `<goal_formulation>
The operator requested a persistent Goal. The preceding user message is their literal request; this block is host instruction, not their words.
Understand the desired result from that request and already available context. Persist a simple definition with only essential, observable criteria via create_goal promptly. Do not invent a technical checklist, architecture, phases, files to change, or validation the operator did not ask for. Optional constraints and exclusions belong only when they are relevant.
A one-off read is allowed only when the request names a document whose content is required to understand the objective; stop as soon as that result is clear. Do not audit the repository, map dependencies, investigate feasibility, or run tests in order to create the Goal. Uncertainty about how to implement does not delay persistence. Ask the operator only when a decision about the desired result cannot be resolved from context.
Workspace writes, shell, external effects, skills, workflows, tasks, and work-executing delegation are not admitted until create_goal has been durably committed. After that, investigate, plan, and implement as the work requires. /plan organizes execution; it is not a prerequisite for creating the Goal.
</goal_formulation>`;

/** Model-facing projection excludes the session audit and private operation receipts. */
export function goalModelView({
  goal,
  evidence,
  evidence_unavailable,
}: GoalRuntimeSnapshot): Record<string, unknown> {
  const run = goal.runs.at(-1);
  return {
    goal_id: goal.goal_id,
    revision: goal.revision,
    objective_revision: goal.objective_revision,
    objective: goal.objective,
    criteria:
      goal.criteria.length === 0
        ? [{ id: "objective", kind: "qualitative", description: goal.objective }]
        : goal.criteria,
    constraints: goal.constraints,
    exclusions: goal.exclusions,
    assumptions: goal.assumptions,
    normative_sources: goal.sources,
    status: goal.status,
    reason: goal.reason,
    limits: goal.limits,
    consumption: goal.consumption,
    auto_continuations: goal.auto_continuations,
    no_progress_stages: goal.no_progress_stages,
    progress: run?.progress,
    checkpoint: run?.checkpoint,
    evidence,
    ...(evidence_unavailable === undefined ? {} : { evidence_unavailable }),
    accepted_human_criteria: goal.human_acceptances
      .filter((acceptance) => acceptance.objective_revision === goal.objective_revision)
      .map((acceptance) => acceptance.criterion_id),
  };
}

/** Compact current reminder for a named stable block; old publications remain historical. */
export function goalContextBlock({ goal, evidence_unavailable }: GoalRuntimeSnapshot): string {
  const criteria = goal.criteria.map((criterion) => ({
    id: criterion.id,
    kind: criterion.kind,
    description: criterion.description.slice(0, 192),
  }));
  return [
    "<goal>",
    "The latest goal reminder describes current state; prior reminders are history. " +
      "The host store controls authority. Use get_goal for the complete semantic definition and criteria.",
    JSON.stringify({
      goal_id: goal.goal_id,
      objective_revision: goal.objective_revision,
      objective: goal.objective.slice(0, 4096),
      criteria: criteria.length === 0 ? [{ id: "objective", kind: "qualitative" }] : criteria,
      constraints: goal.constraints.map((item) => item.slice(0, 192)),
      exclusions: goal.exclusions.map((item) => item.slice(0, 192)),
      assumptions: goal.assumptions.map((item) => item.slice(0, 192)),
      normative_sources: goal.sources,
      status: goal.status,
      ...(evidence_unavailable === undefined ? {} : { evidence_unavailable }),
    }),
    "Pass one update object to update_goal: progress to record work, checkpoint with summary and next_step to request " +
      "a stage ending, or candidate with every criterion before the normal final answer. " +
      "Checkpoint preserves open plan tasks; plan review and child settlement still apply. " +
      "Qualitative judgments are model assessments; human acceptance comes only from the user. " +
      "Evidence IDs come from the host. Report blocked when a decision, authorization or resource " +
      "is missing. Checkpoint and candidate never authorize another run or more budget.",
    "</goal>",
  ].join("\n");
}
