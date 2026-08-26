import { renderPlan } from "../format.ts";
import type { PlanDocument } from "../schemas.ts";
import type { MissingPlanState } from "./session.ts";

/**
 * The plan as the model sees it each iteration: the whole Markdown document,
 * preceded by the compare-and-swap triple.
 *
 * The digests are computed, not stored in the frontmatter, so `renderPlan`
 * alone leaves the model unable to call `revise_plan`/`transition_plan_task` —
 * both demand `expected_digest` and `expected_spec_digest`. Surfacing them here
 * means the current values are always in context and a mutation never needs a
 * `read_plan` first.
 *
 * It also states the approval posture in words. A plan whose approval a
 * revision has just revoked is indistinguishable from an approved one in the
 * rendered document alone — `approved_spec_revision` simply stops being
 * emitted — so the model had no way to connect its own edit to the tool blocks
 * that followed.
 */
export function planCanonicalState(document: PlanDocument, reviewRequired: boolean): string {
  return [planCasHeader(document, reviewRequired), "", renderPlan(document)].join("\n");
}

/**
 * Canonical tombstone for a plan whose provider record disappeared.
 *
 * @remarks This replaces both halves of the live plan context. Without an
 *   explicit tombstone, the old stable block and CAS header keep telling the
 *   model that a deleted plan is current, which turns one filesystem accident
 *   into an unbounded retry loop.
 */
export function missingPlanCanonicalState(missing: MissingPlanState): string {
  return [missingPlanHeader(missing), "", missingPlanSpecBlock(missing)].join("\n");
}

/** The volatile instruction that replaces a removed plan's stale CAS header. */
export function missingPlanHeader(missing: MissingPlanState): string {
  const locator = missing.path ?? missing.id;
  return [
    `Plan unavailable: ${locator} (id: ${missing.id})`,
    "There is NO active plan. The backing record disappeared and Clarvis invalidated its cached state.",
    "Do not reuse any earlier expected_revision, expected_digest or expected_spec_digest values.",
    "Restore the backing record or call create_plan to start a replacement plan before tracking more work.",
  ].join("\n");
}

/** The durable block that supersedes every earlier copy of the removed plan. */
export function missingPlanSpecBlock(missing: MissingPlanState): string {
  const locator = missing.path ?? missing.id;
  return [
    "NO ACTIVE PLAN.",
    `The previous plan (${locator}) is unavailable because its backing record was removed.`,
    "This block supersedes every earlier plan document in the conversation. Its task list, statuses",
    "and compare-and-swap values are historical only. Create or restore a plan before reporting further",
    "plan progress.",
  ].join("\n");
}

/**
 * The small, volatile half of the canonical state: the plan's location, the
 * compare-and-swap triple, the approval posture, and every task's current
 * status.
 *
 * @param document - the plan being published as canonical state.
 * @param reviewRequired - whether *this run* carries the review gate.
 * @returns the header, a few hundred bytes even for a large plan.
 * @remarks This is the only part re-pinned at the end of the transcript each
 *   iteration, so it is also the only part re-sent uncached every iteration.
 *   Everything here genuinely changes as work advances; the plan's substance
 *   lives in {@link planSpecBlock}, which sits behind the cache breakpoint.
 *   Statuses are listed for **all** tasks so the spec block never has to carry
 *   them — carrying them there would make its bytes change on every
 *   `transition_plan_task` and invalidate the cached prefix behind it.
 */
export function planCasHeader(document: PlanDocument, reviewRequired: boolean): string {
  const open = document.tasks.filter(
    (task) => task.status !== "done" && task.status !== "abandoned",
  );
  return [
    `Plan file: ${document.path}`,
    `Pass these unchanged as the expected_* arguments of the next plan mutation:`,
    `  expected_revision: ${document.revision}`,
    `  expected_digest: ${document.digest}`,
    `  expected_spec_digest: ${document.spec_digest}`,
    approvalLine(document, reviewRequired),
    open.length === 0
      ? "Open tasks: none"
      : `Open tasks: ${open.map((task) => `${task.id} (${task.status})`).join(", ")}`,
    document.tasks.length === 0
      ? "Task status: (no tasks yet)"
      : `Task status: ${document.tasks.map((task) => `${task.id} (${task.status})`).join(", ")}`,
  ].join("\n");
}

/**
 * The stable half of the canonical state: the plan's *substance*, published as a
 * durable block that is only ever appended, never edited.
 *
 * @param document - the plan being published as canonical state.
 * @returns the objective, context, each task's id/title/detail/exit, and the
 *   validation checklist.
 * @remarks The field set deliberately mirrors `@clarvis/plan`'s `specDigest` —
 *   objective, context, per-task `id`/`title`/`detail`/`exit`, validation — so
 *   these bytes change if and only if `spec_revision` does. Task statuses,
 *   results, errors, reasons, assignees, notes and the frontmatter (`revision`,
 *   `updated_at`) are all excluded on purpose: they move on every task
 *   transition, and including them would append a fresh copy of this block on
 *   every transition instead of only on a real revision. Anything omitted here
 *   remains reachable through `read_plan`.
 *
 *   Because {@link LiveContext.setStableBlock} appends rather than edits, a
 *   revised plan leaves its earlier copies in the transcript. The preamble
 *   therefore states that the last copy wins — without it a model reading top to
 *   bottom has no way to tell a superseded plan from the live one.
 */
export function planSpecBlock(document: PlanDocument): string {
  const tasks = document.tasks.map((task) => {
    const lines = [`- (${task.id}) ${task.title}`];
    if (task.detail !== undefined) lines.push(`  Detail: ${task.detail}`);
    if (task.exit !== undefined) lines.push(`  Exit: ${task.exit}`);
    return lines.join("\n");
  });
  return [
    "The plan's substance, unchanged until it is revised. A revision appends a fresh copy of",
    "this block rather than editing this one, so if more than one appears in this conversation",
    "the LAST one is the plan and every earlier copy is superseded history. Current task",
    "statuses and the expected_* arguments are pinned separately at the end of this",
    "conversation; anything omitted here (notes, task results) is available through read_plan.",
    "",
    "## Objective",
    "",
    document.objective,
    "",
    "## Context",
    "",
    document.context,
    "",
    "## Tasks",
    "",
    tasks.length === 0 ? "(none yet)" : tasks.join("\n"),
    "",
    "## Validation",
    "",
    document.validation.length === 0
      ? "(none yet)"
      : document.validation.map((item) => `- ${item}`).join("\n"),
  ].join("\n");
}

/**
 * The one-line approval posture: whether this run gates on human approval,
 * whether the plan currently holds one, and what revising costs.
 *
 * @param document - the plan being published as canonical state.
 * @param reviewRequired - whether *this run* carries the review gate.
 * @returns the line describing the run's actual posture.
 * @remarks Keyed on the run, not on `document.status`, because the document
 *   cannot report a property of the run. A plan can carry `awaiting_approval`
 *   into a run with no gate, and a continued run resets a stale status to
 *   `active` while its gate is very much on — so deriving the posture from the
 *   status alone can state the exact opposite of what the runtime enforces,
 *   which is the confusion this line exists to remove.
 */
function approvalLine(document: PlanDocument, reviewRequired: boolean): string {
  if (!reviewRequired) return "Approval: not required for this run.";
  if (document.approved_spec_revision === document.spec_revision)
    return (
      "Approval: approved at this revision — execute the plan. Editing the objective, context, " +
      "tasks or validation revokes the approval and re-opens the review gate, so revise only when " +
      "the plan is actually wrong."
    );
  return (
    "Approval: AWAITING HUMAN APPROVAL — most tools are blocked until it is granted. " +
    "Call submit_result or delegate_task to present this plan for approval; revise_plan first " +
    "if it still needs changes."
  );
}
