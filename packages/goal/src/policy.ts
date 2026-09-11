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
  if (goal.consumption.usage_unknown)
    return {
      allowed: false,
      status: "blocked",
      reason: "Usage must be reconciled before continuing",
    };
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
  if (goal.no_progress_checkpoints >= goal.limits.max_no_progress_checkpoints)
    return { allowed: false, status: "blocked", reason: "Goal checkpoint progress limit reached" };
  return { allowed: true, remaining_tokens };
}
