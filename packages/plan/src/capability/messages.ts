/**
 * Runtime note injected when a `plan_review` run tries to finalize without a
 * reviewable plan, telling the Lead to author one with `create_plan` (prose is
 * neither reviewed nor executed) before the gate can be presented.
 */
export const PLAN_REVIEW_BYPASS_NOTE =
  "[runtime: this run requires human plan review. A plan written as ordinary text is not reviewed or " +
  "executed. Author the plan with create_plan — once a plan exists, spawning waits for the human's " +
  "approval of the current revision. You may ask the human to clarify (ask_user) before authoring. " +
  "If you finalize again without authoring a plan, the run will stop unreviewed.]";

/**
 * Result text for a workspace-changing tool call refused because the run
 * requires human plan review and **no plan exists yet**.
 *
 * @param tool - the refused tool's wire name.
 *
 * @remarks This is the moment the review contract should first reach the model,
 *   and until it existed nothing did: the requirement was stated only inside
 *   the child-spawn tool descriptions, so a Lead that did the work itself learned of
 *   it from {@link PLAN_REVIEW_BYPASS_NOTE} — at the *finalize* attempt, with the
 *   job already done. One measured run wrote three files and ran two commands
 *   before anything spoke, then authored a plan titled "(completed)" describing
 *   work already shipped, and a human "approved" a fait accompli.
 *
 *   It names the read-only tools explicitly because the alternative reading —
 *   "author a plan now" — is what produces an uninformed plan.
 */
export const planReviewUnplannedBlock = (tool: string): string =>
  `blocked: this run requires human plan review and no plan exists yet, so nothing may change ` +
  `in the workspace before a human approves one. '${tool}' becomes available the moment the plan ` +
  `is approved. Investigate first with the read-only tools (read_file, read_files, list_dir, glob, ` +
  `grep, diff, file_stat, tree), then author the plan with create_plan; use ` +
  `ask_user if you need the human to settle something before you can write it. Do not describe the ` +
  `plan as ordinary text — prose is neither reviewed nor executed.`;

/**
 * Result text for a run-spawning tool refused because the run is held for human
 * plan review.
 *
 * @param tool - the refused tool's wire name.
 *
 * @remarks Separate from {@link planReviewUnplannedBlock} because that one's
 *   reason — "nothing may change in the workspace" — is not why this is
 *   refused. A spawned run may well be read-only; the point is that the caller
 *   does not bound it. It carries a profile the caller names, its own
 *   capability set, and no plan gate of its own, so allowing it is allowing the
 *   entire job to happen where this gate cannot see it. It says so, and names
 *   the spawn that *is* available, so the model is not left guessing that
 *   delegation as a whole is closed.
 */
export const planReviewSpawnBlock = (tool: string): string =>
  `blocked: this run is held for human plan review, and '${tool}' starts an independent run whose ` +
  `own tools this gate does not bound — so it stays unavailable until the human approves the plan. ` +
  `Investigate with the read-only tools, and use spawn_subagent if you need a Sub-agent to inform ` +
  `the plan: a Sub-agent runs inside this run's own toolset, which is why it is allowed here and a ` +
  `leader is not. Author the plan with create_plan, then spawn once it is approved.`;

/**
 * Result text for a tool call refused because the plan exists but the human has
 * not approved the current revision.
 *
 * @remarks Narrower than {@link planReviewUnplannedBlock} on purpose: once the
 *   plan is written there is nothing left to investigate for, so the read-only
 *   tools are withheld too and the only way forward is to present or revise.
 */
export const PLAN_REVIEW_AWAITING_APPROVAL_BLOCK =
  "blocked while the plan is awaiting approval. Only plan reads/revisions, skills, user " +
  "elicitation and sub-agent supervision are available. To present the plan for approval, call " +
  "submit_result, spawn_subagent, or delegate_task; revise_plan first if the plan still needs changes.";

/**
 * Termination message for a `plan_review` run that kept finalizing without ever
 * authoring a reviewable plan, so the human review gate was never reached.
 */
export const PLAN_REVIEW_BYPASS_MSG =
  "plan_review run terminated unreviewed: the Lead kept finalizing without authoring a reviewable plan " +
  "via create_plan, so the human review gate was never presented.";

/**
 * Runtime note injected once the human approves the plan, directing the Lead to
 * execute each task — recording it with `transition_plan_task` or delegating it
 * with `delegate_task` — rather than stopping with prose.
 */
export const PLAN_REVIEW_EXECUTE_NOTE =
  "[runtime: the human APPROVED the plan. Execute it now — for each task, either do it yourself and " +
  "record it with transition_plan_task (its task_id), or delegate it with delegate_task (its task_id). If the " +
  "plan genuinely needs no execution, you may finalize; otherwise do not stop with prose.]";

/**
 * `delegate_task`'s description when the run is planning, replacing the
 * plan-free wording.
 *
 * @remarks It lives here rather than beside the engine's delegation tool
 *   builder so that builder carries no plan vocabulary: planning hands its own
 *   description over through {@link import("./task-port.ts").PlanDelegationPort}.
 */
const DELEGATE_TASK_PLAN_DESCRIPTION =
  "Delegate one existing plan task to a Sub-agent. task_id is required and must be copied exactly " +
  "from the current plan; never invent, guess, or use a placeholder id. Use spawn_subagent instead " +
  "for independent work that does not implement a plan task. The Sub-agent returns a text result " +
  "or an error.";

/**
 * Appended to {@link DELEGATE_TASK_PLAN_DESCRIPTION} under `plan_review`, so the
 * model reads the gate's real scope — including that pre-plan exploration is
 * exempt — rather than discovering it at its first refused spawn.
 */
const DELEGATE_TASK_PLAN_REVIEW_SUFFIX =
  " This run requires human plan review: once a plan exists, spawning waits until the human " +
  "approves the current plan revision (revising invalidates approval), and the run cannot finalize " +
  "without an approved plan. Use spawn_subagent for pre-plan exploration; delegate_task remains " +
  "reserved for an exact existing plan task.";

/** The `task_id` input property planning adds to `delegate_task`'s schema. */
const DELEGATE_TASK_TASK_ID_PROPERTY: { task_id: Record<string, unknown> } = {
  task_id: {
    type: "string",
    minLength: 1,
    description:
      "REQUIRED — exact id of the existing plan task this Sub-agent implements. Never invent an id; use spawn_subagent for independent work.",
  },
};

/**
 * Build planning's contribution to `delegate_task`'s advertised schema.
 *
 * @param planReview - whether this run holds the plan for human approval; only
 *   affects the description, which then also states that pre-plan exploration is
 *   exempt.
 * @returns the description and extra input properties the engine's
 *   `buildDelegateTaskTool` folds in. That builder lives in `@clarvis/loop`
 *   (`runtime/subagents/lead-tools.ts`) and is deliberately not linkable from
 *   here: this package must not import the loop.
 * @remarks A pure function rather than an object literal inside the plans
 *   orchestration, so the wording the model actually reads is assertable without
 *   standing up a plan session.
 */
export function buildDelegateTaskPlanAugmentation(planReview: boolean): {
  description: string;
  properties: { task_id: Record<string, unknown> } & Record<string, unknown>;
} {
  return {
    description:
      DELEGATE_TASK_PLAN_DESCRIPTION + (planReview ? DELEGATE_TASK_PLAN_REVIEW_SUFFIX : ""),
    properties: DELEGATE_TASK_TASK_ID_PROPERTY,
  };
}

/**
 * Result text for a `delegate_task` call naming a `task_id` already spawned in
 * this same batch.
 */
export const duplicateBatchTaskId = (taskId: string): string =>
  `duplicate task_id '${taskId}' in this batch — only one Sub-agent per task_id per iteration; spawn the others in a later turn.`;

/**
 * Build the finalization-gate note listing the still-open task `ids` and
 * instructing the Lead to take exactly one closing action per task
 * (`transition_plan_task` or `delegate_task`) before finalizing.
 */
export const PENDING_TASKS_NOTE = (ids: string[]): string =>
  `[runtime: ${ids.length} plan task(s) are still open (${ids.join(", ")}). ` +
  "Do NOT finalize yet — for each remaining task, take exactly one closing action: if you completed it " +
  "yourself, record it with transition_plan_task (its task_id + a short result); to hand it off, spawn a Sub-agent " +
  "(delegate_task with its task_id); or, if it is genuinely unnecessary, abandon it with transition_plan_task. " +
  "Finalize only when no task is left open. If you finalize again with tasks still open, the run will " +
  "stop unfinished.]";
