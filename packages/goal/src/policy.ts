import { GoalError } from "./errors.ts";
import {
  goalLimitsSchema,
  goalUsageSchema,
  GOAL_RUNS_MAX,
  type GoalLimits,
  type GoalRecord,
  type GoalUsage,
} from "./schemas.ts";

/** An explicit finite total is inherited once, never multiplied by the number of runs. */
export function resolveGoalLimits(
  input: Partial<GoalLimits>,
  entryTokenLimit?: number,
): GoalLimits {
  const result = goalLimitsSchema.safeParse({
    ...input,
    max_net_tokens: input.max_net_tokens ?? entryTokenLimit,
  });
  if (!result.success)
    throw new GoalError(
      "invalid_request",
      "Goal requires valid finite token and continuation limits",
    );
  return result.data;
}

/** Whether a run still occupies this goal, independently of semantic status. */
export function goalHasPhysicalRun(goal: GoalRecord): boolean {
  return goal.runs.some((run) => run.phase !== "closed");
}

/** Confirmed net spend; missing cache is conservatively charged, missing total remains unknown. */
export function goalNetTokens(usage: GoalUsage): number | undefined {
  const parsed = goalUsageSchema.parse(usage);
  if (parsed.kind === "unknown") return undefined;
  const total = Math.max(0, parsed.input - (parsed.cached ?? 0)) + parsed.output;
  if (!Number.isSafeInteger(total))
    throw new GoalError("resource_exhausted", "Goal usage exceeds safe accounting range");
  return total;
}

export type GoalAdmissionDecision =
  | { allowed: true; remaining_tokens: number }
  | {
      allowed: false;
      status: "paused" | "blocked" | "budget_limited" | "usage_limited";
      reason: string;
    };

/** Return the absolute deadline decision shared by admission, execution and settlement. */
export function goalDeadlineLimit(
  goal: GoalRecord,
  now: number,
): Extract<GoalAdmissionDecision, { allowed: false }> | undefined {
  return goal.limits.deadline_at !== undefined && now >= goal.limits.deadline_at
    ? { allowed: false, status: "usage_limited", reason: "Goal deadline reached" }
    : undefined;
}

/** Pure admission policy; the host must also hold current controller authority and conversation exclusion. */
export function goalAdmission(
  goal: GoalRecord,
  now: number,
  automatic: boolean,
): GoalAdmissionDecision {
  if (goal.status !== "active")
    return {
      allowed: false,
      status: "paused",
      reason: "Goal is not active; explicit control is required",
    };
  if (goalHasPhysicalRun(goal))
    return {
      allowed: false,
      status: "blocked",
      reason: "The previous goal run is not physically settled",
    };
  /**
   * A gap in the consumption record suspends *automatic* admission only.
   *
   * @remarks An explicit decision is what accepts a gap: the operator is told which stage is not
   *   fully measured and resumes, and the control path records that acceptance. Gating the manual
   *   decision on the gap it is about to accept would leave no way to accept it at all, which is
   *   how a Goal whose telemetry never arrived became permanently unresumable. A gap of a *new*
   *   execution is unaccepted again, so the acceptance is not a standing bypass.
   */
  if (automatic) {
    const unaccepted = unacceptedUsageRuns(goal);
    if (unaccepted.length > 0)
      return {
        allowed: false,
        status: "blocked",
        reason: `Consumption is not fully measured for ${String(unaccepted.length)} closed stage(s) (${describeExecutions(unaccepted)}); resume the goal to accept that gap`,
      };
  }
  const remaining_tokens = goal.limits.max_net_tokens - goal.consumption.net_tokens;
  if (remaining_tokens <= 0)
    return { allowed: false, status: "budget_limited", reason: "Goal token budget exhausted" };
  const deadline = goalDeadlineLimit(goal, now);
  if (deadline !== undefined) return deadline;
  if (automatic && goal.auto_continuations >= goal.limits.max_auto_continuations)
    return {
      allowed: false,
      status: "usage_limited",
      reason: "Goal automatic continuation limit reached",
    };
  if (goal.runs.length >= GOAL_RUNS_MAX)
    return { allowed: false, status: "blocked", reason: "Goal execution audit capacity reached" };
  if (goal.no_progress_stages >= goal.limits.max_no_progress_stages)
    return { allowed: false, status: "blocked", reason: "Goal stage progress limit reached" };
  return { allowed: true, remaining_tokens };
}

/**
 * Closed executions whose consumption is not fully measured and not yet accepted.
 *
 * @param goal - the goal to read.
 * @returns the execution ids, in audit order.
 * @remarks "Fully measured" is `complete`; a `partial` subtotal and an `unknown` scope both leave
 *   something unaccounted for, and both need an explicit decision before automatic work resumes.
 *   The per-execution granularity is what keeps an old acceptance from covering a later gap.
 */
export function unacceptedUsageRuns(goal: GoalRecord): string[] {
  const accepted = new Set(goal.consumption.usage_accepted_runs);
  return goal.runs
    .filter((run) => run.phase === "closed" && run.usage?.kind !== "complete")
    .filter(
      (run) =>
        !accepted.has(run.execution_id) || run.accepted_usage_gaps !== usageGapIdentity(run.usage),
    )
    .map((run) => run.execution_id);
}

/**
 * Name a bounded few of the executions an operator-facing reason is about.
 *
 * @param executions - the execution ids, in audit order.
 * @returns up to three ids and, past that, how many more there are.
 * @remarks The reason travels into a kernel error and from there to a client, so it names enough
 *   executions to be recognizable without growing with the audit: a goal with a hundred unmeasured
 *   stages must not produce a hundred-id sentence.
 */
export function describeExecutions(executions: readonly string[]): string {
  const shown = executions.slice(0, 3).join(", ");
  const rest = executions.length - Math.min(3, executions.length);
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

/** Gap identity excludes changing subtotals; a new unresolved gap requires new authority. */
export function usageGapIdentity(usage: GoalUsage | undefined): string {
  return JSON.stringify(usage?.kind === "partial" ? usage.gaps : (usage?.kind ?? "unknown"));
}
