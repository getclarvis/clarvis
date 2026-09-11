/**
 * Runtime note injected when a `plan_review` run tries to finalize without a
 * reviewable plan, telling the Lead to author one with `create_plan` (prose is
 * neither reviewed nor executed) before the gate can be presented.
 */
export const PLAN_REVIEW_BYPASS_NOTE =
  "[runtime: this run requires human plan review. A plan written as ordinary text is not reviewed or " +
  "executed. Author the plan with create_plan — once a plan exists, spawning waits for the human's " +
  "approval of the current revision. Use ask_user, if available, for missing decisions. " +
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
 *   It permits investigation without enumerating tools that this run may not expose.
 */
export const planReviewUnplannedBlock = (tool: string): string =>
  `blocked: this run requires human plan review and no plan exists yet, so nothing may change ` +
  `in the workspace before a human approves one. '${tool}' is blocked by review. Investigate with ` +
  `available read-only tools, then create_plan; use ask_user, if available, for missing decisions. ` +
  `Ordinary text is not a reviewable plan. Approval clears this gate, not other tool restrictions.`;

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
  `Investigate with available read-only tools; spawn_subagent, if exposed, can help inform the plan ` +
  `under this run's review gate. Author the plan with create_plan and obtain approval before ` +
  `starting independent runs.`;

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
  "elicitation and sub-agent supervision may be used when exposed. To request approval, attempt " +
  "finalization (submit_result when exposed, otherwise final text) or an available child-spawn tool. " +
  "Use revise_plan first if the plan needs changes.";

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
  "[runtime: the human APPROVED the plan. Execute its tasks directly or with delegate_task, if " +
  "exposed, using exact task_ids. Review returned work and record actual outcomes with " +
  "transition_plan_task. Approval or delegation alone does not complete the work.]";

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
  "from the current plan. Use spawn_subagent instead for independent work. The child shares the " +
  "workspace and receives only the brief, not your conversation. Returns a result/error inline or " +
  "a background handle. Successful work becomes returned, not done: review it, then record its " +
  "actual outcome with transition_plan_task.";

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
  `duplicate task_id '${taskId}' in this batch — only one Sub-agent per task_id per iteration; inspect the existing attempt before deciding whether another is needed.`;

/**
 * Build the finalization-gate note listing the still-open task `ids` and
 * distinguishing work and delegation from an evidence-backed terminal transition.
 */
export const PENDING_TASKS_NOTE = (ids: string[]): string =>
  `[runtime: ${ids.length} plan task(s) are still open (${ids.join(", ")}). ` +
  "Do NOT finalize yet. Continue the work directly or with delegate_task if exposed. Delegation " +
  "and returned/failed states do not close tasks. Review the outcome, then use transition_plan_task: " +
  "done requires an observed result; abandoned requires a genuine reason to stop. Do not invent " +
  "success or abandon needed work just to pass this gate. Repeated finalization with open tasks " +
  "stops the run unfinished.]";
