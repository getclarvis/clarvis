import { settleGoalRun, type GoalRunFailureCause, type GoalUsage } from "@clarvis/goal";
import type { ModelCost, RunResult, Session } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { addRunUsage } from "../sessions/usage.ts";
import { goalStateFromSession, goalStateToDto } from "./session-state.ts";
import { measureGoalRunUsage } from "./usage.ts";

/** Host evidence/gate decision for a physically closed execution, never supplied by a guest. */
export interface GoalSettlementDecision {
  disposition: "final" | "checkpoint";
  completion_validated: boolean;
  /** When supplied, measured at the host provider port rather than inferred from loop totals. */
  usage?: GoalUsage;
}

/**
 * Translate the run's own safe terminal code into the goal domain's failure vocabulary.
 *
 * @param result - the physically closed run result.
 * @returns the typed cause for a stop the domain can name, or `undefined` for any
 *   other failure so the domain keeps its generic wording.
 * @remarks The mapping is deliberately closed and lives here rather than in the
 *   domain: the engine's error codes are engine vocabulary, and the goal domain
 *   only needs to know that a stage stagnated or that its control failed. The
 *   result's `message` is never forwarded — a reason in durable goal state must not
 *   be whatever prose the failed run produced.
 *
 *   Every code in {@link STAGNATION_CODES} means the same thing to an operator: the
 *   stage kept going without advancing. Naming only the loop's own no-progress
 *   streak would leave a stage that repeated identical tool results, or the same
 *   failing call, reporting a generic failure for a condition the plan requires to
 *   be diagnosed specifically. A structural failure such as an empty response, and
 *   a run whose tools all disappeared, are not repetition: they keep the generic
 *   wording because the run's own message already explains them.
 */
function goalFailureCause(result: RunResult): GoalRunFailureCause | undefined {
  if (STAGNATION_CODES.has(result.error?.code ?? "")) return "stagnation";
  if (result.error?.code === "goal_control_failed") return "control_failure";
  return undefined;
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

/**
 * Apply goal settlement and its confirmed session usage within the caller's canonical transaction.
 * Returns false for an unrelated run, leaving ordinary accounting to the host. An unknown measure
 * charges nothing until reconciled and remains explicitly unknown in the goal audit. Repeated
 * callbacks or late usage after replacement always resolve the original binding.
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
  const alreadyCharged = run.phase === "closed" && run.usage?.kind === "measured";
  const usage = decision.usage ?? measureGoalRunUsage(result.usage);
  const failureCause = goalFailureCause(result);
  const next = settleGoalRun(state, {
    goal_id: goal.goal_id,
    execution_id: result.execution_id,
    physical_closed: true,
    outcome: result.status,
    disposition: decision.disposition,
    completion_validated: decision.completion_validated,
    usage,
    ...(failureCause === undefined ? {} : { failure_cause: failureCause }),
    now,
  });
  session.goal_state = goalStateToDto(next);
  if (!alreadyCharged && usage.kind === "measured") {
    const detail = result.usage?.by_agent;
    const reported = measureGoalRunUsage(result.usage);
    const detailMatches =
      reported.kind === "measured" &&
      reported.input === usage.input &&
      reported.output === usage.output &&
      reported.cached === usage.cached;
    addRunUsage(
      session.totals,
      {
        iterations: result.usage?.iterations ?? 0,
        elapsed_ms: result.usage?.elapsed_ms ?? 0,
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(usage.cached === undefined ? {} : { cached_tokens: usage.cached }),
        ...(detail === undefined ||
        !detailMatches ||
        usage.cached === undefined ||
        detail.some((agent) => agent.cached_tokens === undefined)
          ? {}
          : { by_agent: detail }),
      },
      priceFor,
    );
  }
  return true;
}
