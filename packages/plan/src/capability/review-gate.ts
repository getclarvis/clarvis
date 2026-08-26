import type { ComputeClock } from "@clarvis/capability";
import {
  PLAN_REVIEW_ELICIT_KIND,
  elicitWithClockPause,
  type Elicit,
  type ElicitParams,
  type ElicitRawResult,
} from "@clarvis/capability";

/**
 * The human's verdict on a proposed plan: `approve` it, `request_changes` (with
 * optional feedback), `cancel` the run, or `no_human` — the elicit produced no
 * usable answer (declined, timed out, or no elicitation channel).
 */
export type PlanReviewDecision =
  | { kind: "approve" }
  | { kind: "request_changes"; feedback?: string }
  | { kind: "cancel" }
  | { kind: "no_human" };

/** Presents the plan-review prompt to the human and resolves their
 * {@link PlanReviewDecision}. */
export type PlanReviewAsk = () => Promise<PlanReviewDecision>;

/**
 * Compose the rejection returned to the model when the human requested changes,
 * telling it to `revise_plan` and then retry the given action.
 *
 * @param feedback - the human's notes, if any.
 * @param retry - the phrase naming what to do after revising (e.g. re-finalize).
 */
export function planNotApprovedRejection(feedback: string | undefined, retry: string): string {
  return feedback !== undefined
    ? `Plan not approved. The human requested changes: ${feedback} Revise the plan with revise_plan, then ${retry}.`
    : `Plan not approved. The human requested changes (no specific notes). Revise the plan with revise_plan, then ${retry}.`;
}

/**
 * Build the elicit request (kind + message + JSON schema) that asks the human to
 * approve, request changes on, or cancel the proposed plan.
 *
 * @remarks **`request_changes` is listed first on purpose.** A client seeds a
 * choice field with the schema's `default`, else its first option, so enum order
 * decides what sits under the cursor — and a single stray Enter on a prompt
 * whose first option is `approve` approves the plan. That is the one answer this
 * gate exists to make deliberate. The guard-confirmation prompt already lists
 * `deny` first for the same reason; this is that convention, applied to the
 * other gate that asks a human to authorize work.
 */
export function buildPlanReviewElicitParams(): ElicitParams {
  return {
    kind: PLAN_REVIEW_ELICIT_KIND,
    message:
      "The Lead has proposed a plan (shown above). Approve it, request changes, or cancel the run?",
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["request_changes", "approve", "cancel"],
          description: "Request changes, approve the plan, or cancel the run.",
        },
        feedback: {
          type: "string",
          description: "Optional notes for the Lead when requesting changes.",
        },
      },
      required: ["decision"],
    },
  };
}

/**
 * Interpret a raw elicit result into a {@link PlanReviewDecision}.
 *
 * @param raw - the elicit outcome; anything but an `accept` action, or an
 *   unrecognized/missing `decision`, maps to `no_human`.
 */
export function mapPlanReviewAnswer(raw: ElicitRawResult): PlanReviewDecision {
  if (raw.action !== "accept") return { kind: "no_human" };
  const content = raw.content ?? {};
  const decision = content.decision;
  if (decision === "approve") return { kind: "approve" };
  if (decision === "cancel") return { kind: "cancel" };
  if (decision === "request_changes") {
    const fb = content.feedback;
    return {
      kind: "request_changes",
      ...(typeof fb === "string" && fb.length > 0 ? { feedback: fb } : {}),
    };
  }
  return { kind: "no_human" };
}

/**
 * Build a {@link PlanReviewAsk} that presents the review prompt through
 * `elicit` while pausing the compute `clock` for the duration of the human
 * wait, so idle review time is not charged against the run's budget.
 *
 * @param elicit - the host elicitation channel.
 * @param clock - the compute clock paused around the wait.
 * @param signal - optional abort signal forwarded to the elicit.
 * @param waitBoundMs - optional bound on the human wait.
 * @returns an ask that resolves the {@link PlanReviewDecision}, yielding
 *   `no_human` when no response arrives.
 */
export function buildPlanReviewAsk(
  elicit: Elicit,
  clock: ComputeClock,
  signal?: AbortSignal,
  waitBoundMs?: number,
): PlanReviewAsk {
  return (): Promise<PlanReviewDecision> =>
    elicitWithClockPause<PlanReviewDecision>(
      clock,
      signal,
      () =>
        elicit(buildPlanReviewElicitParams(), {
          ...(signal ? { signal } : {}),
          ...(waitBoundMs !== undefined ? { timeoutMs: waitBoundMs } : {}),
        }),
      { onResult: mapPlanReviewAnswer, onNoResponse: () => ({ kind: "no_human" }) },
    );
}
