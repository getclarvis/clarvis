import { settleGoalRun, type GoalRunCause, type GoalUsage } from "@clarvis/goal";
import type { ModelCost, RunResult, Session } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { addRunUsage } from "../sessions/usage.ts";
import { goalStateFromSession, goalStateToDto } from "./session-state.ts";
import { measureGoalRunUsage } from "./usage.ts";

/** Host evidence/gate decision for a physically closed execution, never supplied by a guest. */
export interface GoalSettlementDecision {
  disposition: "final" | "checkpoint";
  completion_validated: boolean;
  /**
   * The stage's own successful activity receipts, as the host collected them.
   *
   * @remarks Receipts rather than a verdict: the domain compares each one with the Goal's whole
   *   recorded history, so a stage that only recombined receipts an earlier stage already
   *   presented contributes nothing, and a stage that observed nothing is unproductive without
   *   the host having to rule on its semantic value.
   */
  activity?: readonly string[];
  /** Missing observation is uncertainty, not an empty successful measurement. */
  activity_unavailable?: boolean;
  /** When supplied, measured at the host provider port rather than inferred from loop totals. */
  usage?: GoalUsage;
}

/** Why a physically closed stage ended, and how soon a successor may start. */
export interface GoalStageOutcome {
  cause: GoalRunCause;
  /** Earliest instant the host may admit a successor; a provider-requested backoff. */
  not_before?: number;
}

/**
 * The durable instant a successor must still wait for, or nothing once it has passed.
 *
 * @remarks A recorded backoff is a *pending* wait, not a permanent condition. Handing an
 *   elapsed instant to admission refuses the successor for a delay that no longer exists —
 *   which is how a bounded, or zero, provider backoff left a Goal with no successor at all.
 *   The wait is honoured while it remains and dropped once it has elapsed.
 */
export function pendingInstant(notBefore: number | undefined, now: number): number | undefined {
  return notBefore === undefined || notBefore <= now ? undefined : notBefore;
}

/**
 * The run codes that mean one thing to a goal operator: this stage stopped without
 * advancing. `no_progress` is the loop's unproductive-attempt streak,
 * `tool_failure_loop` is the doom-loop guard on a repeatedly failing call, and
 * `stagnation_detected` is the convergence guard on identical repeated results.
 */
const STAGNATION_CODES: ReadonlySet<string> = new Set([
  "no_progress",
  "tool_failure_loop",
  "stagnation_detected",
]);

/** Provider refusals a successor must not repeat without a valid change of conditions. */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "provider_quota_exhausted",
  "provider_content_policy",
]);

/**
 * Longest provider-requested backoff the host waits before starting a successor.
 *
 * @remarks The provider already retried inside the stage under its own ceiling, so
 *   this is only the remainder it asked the caller to respect. Bounding it keeps the
 *   wait a bounded pause in the continuation path rather than a scheduler.
 */
const TRANSIENT_WAIT_MAX_MS = 60_000;

/**
 * Classify one physically closed stage into the goal domain's closed cause vocabulary.
 *
 * @param result - the run's terminal result, after protocol projection.
 * @param now - the host clock, used only to bound a provider-requested backoff.
 * @returns the typed cause and, for a transient provider fault, the earliest instant a
 *   successor may start.
 * @remarks The mapping is deliberately closed and comparative rather than semantic: the
 *   result's own `message` is never forwarded, and the goal domain is never asked to
 *   classify an ending. Everything the host cannot name is `unclassified`, which the
 *   domain refuses to continue — an unrecognised failure is never assumed recoverable.
 *
 *   `budget_exhausted` is reported as a local limit on purpose: only the Goal's own
 *   durable admission can tell a stage that spent its partition from one that exhausted
 *   the objective's budget, so the domain makes that call from its own accounting. The
 *   distinction between a retryable provider fault and a credential or request fault
 *   comes from the provider's own classification, which the engine carries on the error
 *   and the projection preserves as a bounded field.
 */
export function goalStageOutcome(result: RunResult, now: number): GoalStageOutcome {
  if (result.status === "completed")
    return { cause: result.disposition === "checkpoint" ? "checkpoint" : "unclassified" };
  if (result.status === "cancelled") return { cause: "cancelled" };
  if (result.ended_reason === "soft_limit_declined") return { cause: "declined" };
  if (result.ended_reason !== undefined)
    return { cause: result.ended_reason === "budget_exhausted" ? "local_limit" : "unclassified" };
  const error = result.error;
  if (error === undefined) return { cause: "unclassified" };
  if (STAGNATION_CODES.has(error.code)) return { cause: "stagnation" };
  if (error.code === "empty_response") return { cause: "empty_response" };
  if (error.code === "all_tools_unavailable") return { cause: "tools_unavailable" };
  if (error.code === "context_overflow") return { cause: "context_overflow" };
  if (error.code === "goal_control_failed") return { cause: "control_failure" };
  if (error.code === "goal_finalization_conflict") return { cause: "finalization_conflict" };
  if (error.code === "goal_steward_failed" || error.code === "goal_steward_inconclusive")
    return { cause: "steward_interrupted" };
  if (REFUSAL_CODES.has(error.code)) return { cause: "provider_refused" };
  if (error.code === "provider_error") {
    if (error.kind === "auth" || error.kind === "quota" || error.kind === "content_policy")
      return { cause: "provider_refused" };
    if (error.kind === "transient")
      return {
        cause: "transient",
        not_before: now + Math.min(error.retry_after_ms ?? 0, TRANSIENT_WAIT_MAX_MS),
      };
  }
  return { cause: "unclassified" };
}

/**
 * The part of a measurement this settlement still has to charge.
 *
 * @param previous - the measurement the stage's settlement already wrote, when it had one.
 * @param usage - the measurement now being settled.
 * @returns the amounts to add to the session totals, or `undefined` when this measurement carries
 *   no usable subtotal.
 * @remarks A settlement that finds a stage already measured charges only the **difference**, so a
 *   late correction adds what it newly learned instead of charging the stage twice. A stage whose
 *   earlier measurement was unknown never charged anything, so the whole confirmed subtotal is
 *   still owed. A correction that would take consumption back never reaches this function: the
 *   domain refuses it as a conflict first, and the clamp here is only a guard against an accounting
 *   figure that must never be negative.
 */
function usageCredit(
  previous: GoalUsage | undefined,
  usage: GoalUsage,
): { input: number; output: number; cached?: number; cost_usd?: number } | undefined {
  if (usage.kind === "unknown") return undefined;
  if (previous === undefined || previous.kind === "unknown")
    return {
      input: usage.input,
      output: usage.output,
      ...(usage.cached === undefined ? {} : { cached: usage.cached }),
      ...(usage.cost_usd === undefined ? {} : { cost_usd: usage.cost_usd }),
    };
  const cached =
    usage.cached === undefined && previous.cached === undefined
      ? undefined
      : (usage.cached ?? 0) - (previous.cached ?? 0);
  return {
    input: usage.input - previous.input,
    output: usage.output - previous.output,
    ...(cached === undefined ? {} : { cached: cached }),
    ...(usage.cost_usd === undefined
      ? {}
      : { cost_usd: usage.cost_usd - (previous.cost_usd ?? 0) }),
  };
}

/**
 * Apply goal settlement and its confirmed session usage within the caller's canonical transaction.
 * Returns false for an unrelated run, leaving ordinary accounting to the host. A measurement with
 * no usable subtotal charges nothing until it is reconciled and remains explicitly unknown in the
 * goal audit, while a partial one credits the subtotal it did confirm. Repeated callbacks or late
 * usage after replacement always resolve the original binding, and a late revision is charged as a
 * delta rather than a second full charge.
 */
export function settleGoalSession(
  session: Session,
  result: RunResult,
  decision: GoalSettlementDecision,
  now: number,
  priceFor?: (model: string) => ModelCost | undefined,
): boolean {
  const state = goalStateFromSession(session);
  if (state === undefined) return false;
  const goal = [...(state.current === undefined ? [] : [state.current]), ...state.archive].find(
    (goal) => goal.runs.some((run) => run.execution_id === result.execution_id),
  );
  if (goal === undefined) return false;
  if (result.status === "running")
    throw kernelError("invalid_request", "goal settlement requires a terminal run result");
  const run = goal.runs.find((run) => run.execution_id === result.execution_id)!;
  const creditedBefore = run.phase === "closed" ? run.usage : undefined;
  const usage = decision.usage ?? measureGoalRunUsage(result.usage);
  const stage = goalStageOutcome(result, now);
  const next = settleGoalRun(state, {
    goal_id: goal.goal_id,
    execution_id: result.execution_id,
    physical_closed: true,
    outcome: result.status,
    disposition: decision.disposition,
    completion_validated: decision.completion_validated,
    cause: stage.cause,
    ...(stage.not_before === undefined ? {} : { not_before: stage.not_before }),
    ...(decision.activity === undefined ? {} : { activity: decision.activity }),
    ...(decision.activity_unavailable === true ? { activity_unavailable: true } : {}),
    usage,
    now,
  });
  if (JSON.stringify(next) === JSON.stringify(state)) return true;
  session.goal_state = goalStateToDto(next);
  const credit = usageCredit(creditedBefore, usage);
  if (credit !== undefined) {
    /**
     * Per-agent detail belongs to the stage's first credit.
     *
     * @remarks `addRunUsage` charges an attributed breakdown instead of the aggregate figures, so
     *   attaching detail to a delta would charge the whole execution again rather than the
     *   difference. A late correction therefore moves the aggregate totals only, which is what the
     *   Goal's own per-stage accounting reads.
     */
    const firstCredit = creditedBefore === undefined || creditedBefore.kind === "unknown";
    const detail = result.usage?.by_agent;
    const reported = measureGoalRunUsage(result.usage);
    const detailMatches =
      reported.kind !== "unknown" &&
      usage.kind !== "unknown" &&
      reported.input === usage.input &&
      reported.output === usage.output &&
      reported.cached === usage.cached;
    addRunUsage(
      session.totals,
      {
        iterations: result.usage?.iterations ?? 0,
        elapsed_ms: result.usage?.elapsed_ms ?? 0,
        input_tokens: credit.input,
        output_tokens: credit.output,
        ...(credit.cached === undefined ? {} : { cached_tokens: credit.cached }),
        ...(credit.cost_usd !== undefined ||
        !firstCredit ||
        detail === undefined ||
        !detailMatches ||
        usage.cached === undefined ||
        detail.some((agent) => agent.cached_tokens === undefined)
          ? {}
          : { by_agent: detail }),
      },
      priceFor,
    );
    if (credit.cost_usd !== undefined)
      session.totals.cost_usd = (session.totals.cost_usd ?? 0) + credit.cost_usd;
  }
  return true;
}

/** Replay only host-prepared non-final inputs after the registry proves physical closure. */
export function recoverGoalSettlementSession(
  session: Session,
  result: RunResult,
  now: number,
  priceFor?: (model: string) => ModelCost | undefined,
): boolean {
  const goals = [
    ...(session.goal_state?.archive ?? []),
    ...(session.goal_state?.current === undefined ? [] : [session.goal_state.current]),
  ];
  const run = goals
    .flatMap((goal) => goal.runs)
    .find((stage) => stage.execution_id === result.execution_id);
  const preparation = run?.settlement_preparation;
  if (
    preparation === undefined ||
    preparation.outcome !== result.status ||
    preparation.disposition !== (result.disposition ?? "final") ||
    (result.status === "completed" && preparation.disposition !== "checkpoint")
  )
    return false;
  return settleGoalSession(
    session,
    result,
    { ...preparation, completion_validated: false },
    now,
    priceFor,
  );
}
