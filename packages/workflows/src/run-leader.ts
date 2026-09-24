/**
 * {@link runLeader} — run one leader as a fully isolated `executeRun`, fold its
 * usage into the tree ledger, and project its response to a {@link LeaderResult}.
 * This is the primitive the manager's `run_leader` handler drives; it is also
 * usable directly by a non-agentic (scripted) driver over the same context.
 */
import type {
  Capability,
  OutputTokenBudget,
  RunRequest,
  TraceEvent,
  Usage,
} from "@clarvis/capability";
import { levelEnabled } from "@clarvis/capability";
import { createFairShareOutputBudget, type WorkflowReservation } from "./ledger.ts";
import { faultFields, workflowLogger } from "./log.ts";
import type { LeaderResult, LeaderSpec, WorkflowCtx } from "./types.ts";

/** A zeroed {@link Usage} used when a leader never produced a response (e.g. the
 * request failed validation before the loop ran). */
const EMPTY_USAGE: Usage = { iterations_used: 0, elapsed_ms: 0, by_agent: [] };

/** A tool-free capability that carries only the leader subtree's budget. */
export function createLeaderOutputBudgetCapability(
  outputBudget: OutputTokenBudget,
  maxParallelSubagents: number,
): Capability {
  const name = "workflows.output-budget";
  const capability: Capability = {
    name,
    forRun: () => ({
      name,
      forAgent: () => ({
        attach: () => ({
          outputBudget: createFairShareOutputBudget(outputBudget, 1 + maxParallelSubagents),
        }),
      }),
    }),
  };
  outputBudgets.set(capability, { outputBudget, maxParallelSubagents });
  return capability;
}

const outputBudgets = new WeakMap<
  Capability,
  { outputBudget: OutputTokenBudget; maxParallelSubagents: number }
>();

/** Preserve a leader's reserved subtree limit when a trusted host changes execution placement. */
export function workflowOutputBudgetOf(
  capability: Capability,
): { outputBudget: OutputTokenBudget; maxParallelSubagents: number } | undefined {
  return outputBudgets.get(capability);
}

/**
 * Run one leader against the shared {@link WorkflowCtx} and return its outcome.
 *
 * @param spec - the manager's brief for this leader.
 * @param ctx - the tree-wide context (deps, ledger, assembler, signals, channels).
 * @param runId - the leader's execution id; defaults to a fresh one, but the
 *   capability handler pre-generates it so it can record `workflow_run_started`
 *   before the run resolves.
 * @returns the {@link LeaderResult}. Never throws for a run-level fault: a thrown
 *   `executeRun` (validation/persistence) is caught and surfaced as an `error`
 *   status so one bad leader cannot abort the manager.
 * @remarks The leader is assembled WITHOUT the `workflow` grant and with
 *   `plans: "off"` (both enforced by {@link WorkflowCtx.assemble}); it therefore
 *   never receives the `workflows` capability and cannot spawn further leaders.
 */
export async function runLeader(
  spec: LeaderSpec,
  ctx: WorkflowCtx,
  runId: string = ctx.runDeps.generateExecutionId(),
  heldReservation?: WorkflowReservation,
): Promise<LeaderResult> {
  const logger = workflowLogger(ctx);
  const reservation =
    heldReservation ?? ctx.ledger.reserve(ctx.maxConcurrency + ctx.maxParallelSubagents);
  if (reservation === null) {
    ctx.onBudgetExhausted?.();
    return {
      runId,
      status: "budget_exhausted",
      result: undefined,
      usage: EMPTY_USAGE,
    };
  }
  try {
    const base = await ctx.assemble(spec, { parentRunId: ctx.managerRunId, runId });
    const rawBody: RunRequest = { ...base, execution_id: runId };
    const elicit = ctx.elicitForLeader?.(runId);
    const steer = ctx.steerForLeader?.(runId);
    const forward = ctx.onLeaderEvent;
    const onEvent =
      forward === undefined ? undefined : (event: TraceEvent): void => forward(runId, event);
    if (levelEnabled(logger, "debug")) {
      logger.debug(
        {
          event: "workflow.leader_started",
          leader_run_id: runId,
          title: spec.title,
          ...(spec.profile === undefined ? {} : { profile: spec.profile }),
          brief_chars: spec.prompt.length,
          expects_schema: spec.expectSchema !== undefined,
          reservation_tokens: reservation.amount,
          capabilities: (ctx.deps.capabilities ?? [])
            .map((capability) => capability.name)
            .join(","),
        },
        "a leader run is starting over the manager's engine deps; the capabilities named here are the whole surface it gets",
      );
    }
    const { response } = await ctx.runDeps.executeRun({
      rawBody,
      owner: ctx.owner,
      deps: ctx.deps,
      externalSignal: ctx.signal,
      capabilities: [createLeaderOutputBudgetCapability(reservation, ctx.maxParallelSubagents)],
      ...(elicit !== undefined ? { elicit } : {}),
      ...(steer !== undefined ? { steer } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    reservation.reconcile(response.usage);
    if (response.status === "error") {
      return {
        runId,
        status: "error",
        result: undefined,
        usage: response.usage,
        error: { code: response.error.code, message: response.error.message },
      };
    }
    return { runId, status: response.status, result: response.result, usage: response.usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: "workflow.leader_faulted", leader_run_id: runId, ...faultFields(err) },
      "a leader's executeRun threw before it could answer; the manager sees an error result and the stack exists only here",
    );
    return {
      runId,
      status: "error",
      result: undefined,
      usage: EMPTY_USAGE,
      error: { code: "leader_run_failed", message },
    };
  } finally {
    reservation.release();
  }
}
