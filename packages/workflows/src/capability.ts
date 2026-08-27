/**
 * The `workflows` capability — the manager's half of the workflow topology.
 *
 * It contributes the leader ledger to non-manager agents in the primary run,
 * while the manager remains on that run's independent session budget. Only an
 * entry agent carrying the `workflow` grant receives the workflow tools and their
 * handlers. Leader runs receive a separate budget-only capability, so the
 * topology stays fixed at Manager → Leaders → Sub-agents without a depth counter.
 *
 * @remarks Background is the *only* mode, and deliberately not a flag the model
 * can clear. Wide fan-out is a leader's normal case and where a blocked manager
 * hurts most: it goes dark for the length of its slowest leader — unsteerable,
 * unable to see a leader derail, unable to stop one. A model offered a working
 * synchronous path would keep choosing it, so there is no synchronous path.
 */
import type {
  AgentBuildContext,
  AgentCapability,
  AgentLoopContribution,
  AgentRegistryPort,
  AgentScope,
  Capability,
  ComputeClock,
  ComputeRegion,
  HandlerVerdict,
  Logger,
  RunCapability,
  ToolHandler,
} from "@clarvis/capability";
import { bind, parseTaskTitle, TASK_TITLE_MAX } from "@clarvis/capability";
import { AGENT_REGISTRY_PORT, registerBackgroundChild } from "@clarvis/supervision";
import { reportSettled } from "./dispatch.ts";
import type { WorkflowReservation } from "./ledger.ts";
import { faultFields, outputTokensOf, withBoundLogger, workflowLogger } from "./log.ts";
import { describeLeaderResult } from "./result-text.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
export { WORKFLOWS_CAPABILITY_NAME } from "./settings.ts";
import { WORKFLOWS_CAPABILITY_NAME } from "./settings.ts";
import { runLeader } from "./run-leader.ts";
import { buildRunRoundHandler, buildRunRoundTool } from "./run-round.ts";
import { buildRunWorkflowHandler, buildRunWorkflowTool } from "./run-workflow.ts";
import { buildRunLeaderTool, RUN_LEADER_TOOL_NAME } from "./tool.ts";
import type { LeaderSpec, WorkflowCtx } from "./types.ts";
import { buildRunWorkItemsHandler, buildRunWorkItemsTool } from "./work-items.ts";
import {
  recordWorkflowTrace,
  WORKFLOW_PERSISTED_TRACE_PROJECTORS,
  WORKFLOW_RUN_COMPLETED_TRACE_KIND,
  WORKFLOW_RUN_FAILED_TRACE_KIND,
  WORKFLOW_RUN_STARTED_TRACE_KIND,
} from "./trace-events.ts";

/** The grant that designates a manager: only an entry agent carrying it receives
 * `run_leader`. Never propagated to leader runs. */
export const WORKFLOW_GRANT = "workflow";

/** Static declaration that makes a manager entry spawn-capable. */
export const WORKFLOW_GRANT_DECLARATION = {
  name: WORKFLOW_GRANT,
  entryCanSpawn: true,
} as const;

/**
 * Build the `workflows` {@link Capability} bound to one workflow's {@link WorkflowCtx}.
 *
 * @param ctx - the tree-wide context (deps, semaphore, ledger, assembler, signals).
 * @returns a capability that contributes the shared output budget to child agents
 *   and workflow tools only to its granted manager entry agent.
 * @remarks `forRun` returns `null` when the run has no supervision registry.
 * That is not a degradation path but a structural impossibility made explicit:
 * the loop mints a registry for exactly the runs that can spawn, and a manager
 * — an entry agent carrying the `workflow` grant — is always one of them. There
 * is no second, synchronous `run_leader`: a leader that blocked its manager is
 * precisely the defect this capability was rewritten to remove.
 */
export function createWorkflowsCapability(ctx: WorkflowCtx): Capability {
  const tool = buildRunLeaderTool(ctx.leaderProfiles);
  const workItemsTool = buildRunWorkItemsTool(ctx.leaderProfiles);
  const roundTool = buildRunRoundTool(ctx.leaderProfiles);
  const workflows = ctx.workflowDefs ?? [];
  const workflowTool = buildRunWorkflowTool(workflows);
  const capabilityTools =
    workflowTool === null
      ? [tool, workItemsTool, roundTool]
      : [tool, workItemsTool, roundTool, workflowTool];
  const reservedWireNames = capabilityTools.map((candidate) => candidate.wireName);
  /**
   * Every spawn tool is `spawn_run`, not `control`.
   *
   * @remarks A leader is a separate `executeRun` carrying a profile the manager
   *   names and running with `plans` forced off, so nothing the manager is
   *   subject to reaches it. Under `control` the plans capability let these
   *   through in every phase, and a run held for human plan review fanned out a
   *   whole wave of leaders before a plan existed.
   */
  const toolEffects = Object.fromEntries(
    capabilityTools.map((candidate) => [candidate.wireName, "spawn_run"] as const),
  );
  const logger = workflowLogger(ctx);
  const runCapabilityFor = (agents: AgentRegistryPort): RunCapability => ({
    name: WORKFLOWS_CAPABILITY_NAME,
    forAgent(scope: AgentScope): AgentCapability | null {
      const manager = scope.entry && scope.grants.includes(WORKFLOW_GRANT);
      if (!manager) reportInactive(logger, scope);
      const clock = scope.clock;
      return {
        attach(bc: AgentBuildContext): AgentLoopContribution {
          if (!manager) return { outputBudget: ctx.ledger };
          return {
            tools: capabilityTools,
            handlers: [
              buildRunLeaderHandler(ctx, bc, clock, agents),
              buildRunWorkItemsHandler(ctx, bc, clock, agents),
              buildRunRoundHandler(ctx, bc, clock, agents),
              ...(workflowTool === null
                ? []
                : [
                    buildRunWorkflowHandler(
                      ctx,
                      bc,
                      clock,
                      agents,
                      workflows,
                      scope.elicit,
                      scope.signal,
                    ),
                  ]),
            ],
            advertised: true,
          };
        },
      };
    },
  });
  return {
    name: WORKFLOWS_CAPABILITY_NAME,
    grants: [WORKFLOW_GRANT_DECLARATION],
    persistedTraceProjectors: WORKFLOW_PERSISTED_TRACE_PROJECTORS,
    reservedWireNames,
    toolEffects,
    forRun(runCtx): RunCapability | null {
      const agents = runCtx.services.get(AGENT_REGISTRY_PORT);
      if (agents === undefined) {
        logger.warn(
          {
            event: "workflow.capability_inactive",
            reason: "no_registry",
            grants: runCtx.entryGrants.join(","),
          },
          "this run publishes no supervision registry, so the workflow tools are contributed to nobody and the manager has no way to fan out",
        );
        return null;
      }
      return runCapabilityFor(agents);
    },
  };
}

/**
 * Say which of the three topology gates refused an agent the workflow tools.
 *
 * @param logger - the workflow-scoped logger.
 * @param scope - the agent build scope that was refused.
 * @remarks The two reasons are not equally interesting, which is why they are
 *   not at one level. `not_entry` is the ordinary case — every sub-agent of a
 *   manager reaches this — and warning on it would produce a line per
 *   delegation and teach an operator to filter the event out. `no_grant` on an
 *   *entry* agent is the mis-authored profile the gates are silent about: the
 *   run is a manager in every respect except the one that matters, and the only
 *   symptom is that `run_leader` is missing from the tool list.
 */
function reportInactive(logger: Logger, scope: AgentScope): void {
  const fields = {
    event: "workflow.capability_inactive",
    agent: scope.agent,
    grants: scope.grants.join(","),
  };
  if (!scope.entry) {
    logger.debug(
      { ...fields, reason: "not_entry" },
      "a sub-agent of the manager gets the tree budget and no workflow tools, which is what fixes the topology at three levels",
    );
    return;
  }
  logger.warn(
    { ...fields, reason: "no_grant" },
    `this run's entry agent carries no '${WORKFLOW_GRANT}' grant, so it is a manager with no workflow tools; add the grant to its profile`,
  );
}

/**
 * Build the `run_leader` tool handler: register the leader, answer the call with
 * its handle, and let the registry hold the run.
 *
 * @remarks The verdict is an immediate `result`, never a `deferred` — a deferred
 *   one is joined by `runDispatch`'s own `finally` before the manager's iteration
 *   can end, which is exactly what left a manager unreachable for the length of
 *   its fan-out. The semaphore `acquire` consequently sits inside the registry's
 *   task, so a leader still queued for a slot no longer holds the dispatch
 *   either; it takes the leader's combined signal, so stopping a queued leader
 *   rejects the acquire rather than granting a permit nobody will release.
 *   A malformed call still returns a non-terminal textual result so the manager
 *   decides how to proceed. Budget admission happens inside the task immediately
 *   after the semaphore grant: queued leaders hold no token headroom, while the
 *   admitted set still reserves atomically before any model call can dispatch.
 */
function buildRunLeaderHandler(
  ctx: WorkflowCtx,
  bc: AgentBuildContext,
  clock: ComputeClock | undefined,
  agents: AgentRegistryPort,
): ToolHandler {
  const logger = workflowLogger(ctx);
  return {
    matches: (call) => call.name === RUN_LEADER_TOOL_NAME,
    handle(call): Promise<HandlerVerdict> {
      const parsed = parseLeaderSpec(call.arguments);
      if ("error" in parsed) {
        return Promise.resolve(verdict(`run_leader error: ${parsed.error}`));
      }
      const spec = parsed.spec;
      const runId = ctx.runDeps.generateExecutionId();
      const spawned = registerBackgroundChild(agents, bc.trace, {
        kind: "leader",
        nativeId: runId,
        title: spec.title,
        ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
      });
      if (spawned === null) {
        return Promise.resolve(
          verdict(
            "not spawning this leader — too many child agents are already running. Wait with " +
              "await_agents or end one with agent_stop, then try again.",
          ),
        );
      }
      const { handle, controller, steerQueue } = spawned;
      const correlation = { leader_run_id: runId, agent_id: handle.id };
      const leaderLogger = bind(logger, correlation);

      const leaderCtx: WorkflowCtx = {
        ...ctx,
        deps: withBoundLogger(ctx.deps, correlation),
        signal: AbortSignal.any([ctx.signal, controller.signal]),
        steerForLeader: (id) => (id === runId ? steerQueue : ctx.steerForLeader?.(id)),
        onLeaderEvent: (id, event) => {
          if (id === runId) handle.ingest(event);
          ctx.onLeaderEvent?.(id, event);
        },
      };

      const task = (async (): Promise<void> => {
        let region: ComputeRegion | undefined;
        let acquired = false;
        let reservation: WorkflowReservation | null = null;
        try {
          await ctx.semaphore.acquire(leaderCtx.signal);
          acquired = true;
          reservation = ctx.ledger.reserve(ctx.maxConcurrency);
          if (reservation === null) {
            ctx.onBudgetExhausted?.();
            leaderLogger.warn(
              {
                event: "workflow.budget_exhausted",
                total: ctx.ledger.total,
                spent: ctx.ledger.spent(),
                max_concurrency: ctx.maxConcurrency,
              },
              "the admitted leader found no token headroom, so it settles without dispatching a model call",
            );
            handle.settled({
              status: "failed",
              result: "workflow token budget exhausted before this leader could start",
            });
            return;
          }
          recordWorkflowTrace(bc.trace, WORKFLOW_RUN_STARTED_TRACE_KIND, {
            run_id: runId,
            parent_run_id: ctx.managerRunId,
            title: spec.title,
            task: spec.prompt,
            ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
          });
          region = clock?.enterBackground();
          const result = await runLeader(spec, leaderCtx, runId, reservation);
          reportSettled(leaderLogger, result.status === "completed", {
            leader_run_id: runId,
            status: result.status,
            output_tokens: outputTokensOf(result.usage.by_agent),
            elapsed_ms: result.usage.elapsed_ms,
            ...(result.error === undefined ? {} : { error_code: result.error.code }),
          });
          recordWorkflowTrace(
            bc.trace,
            result.status === "completed"
              ? WORKFLOW_RUN_COMPLETED_TRACE_KIND
              : WORKFLOW_RUN_FAILED_TRACE_KIND,
            {
              run_id: runId,
              parent_run_id: ctx.managerRunId,
              status: result.status,
              ...(result.error !== undefined ? { error: result.error } : {}),
            },
          );
          handle.settled({
            status:
              result.status === "completed"
                ? "completed"
                : result.status === "cancelled"
                  ? "stopped"
                  : "failed",
            result: `leader ${runId} ${result.status}: ${describeLeaderResult(result)}`,
          });
        } catch (err) {
          if (!acquired) {
            handle.settled({
              status: "stopped",
              result: "cancelled while waiting for a concurrency slot",
            });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          leaderLogger.error(
            { event: "workflow.leader_faulted", leader_run_id: runId, ...faultFields(err) },
            "an ad-hoc leader threw outside its own error handling; the child settles as failed and the stack exists only here",
          );
          try {
            recordWorkflowTrace(bc.trace, WORKFLOW_RUN_FAILED_TRACE_KIND, {
              run_id: runId,
              parent_run_id: ctx.managerRunId,
              status: "error",
              error: { code: "leader_run_failed", message },
            });
          } finally {
            handle.settled({ status: "failed", result: `leader ${runId} error: ${message}` });
          }
        } finally {
          try {
            region?.leave();
          } finally {
            try {
              reservation?.release();
            } finally {
              try {
                if (acquired) ctx.semaphore.release();
              } finally {
                steerQueue.close();
              }
            }
          }
        }
      })();
      agents.adopt(handle.id, task);

      return Promise.resolve({
        kind: "result",
        text:
          `Tool '${RUN_LEADER_TOOL_NAME}' result: started ${handle.id} (leader ${runId}) in the ` +
          "background. It is running now — keep working, then collect it with await_agents (to " +
          "wait) or agent_poll (to look). Do not finish until it has returned.",
        progress: true,
      });
    },
  };
}

/** A non-terminal, immediate textual verdict prefixed as a `run_leader` result. */
function verdict(text: string): HandlerVerdict {
  return {
    kind: "result",
    text: `Tool '${RUN_LEADER_TOOL_NAME}' result: ${text}`,
    progress: false,
  };
}

/**
 * Parse a `run_leader` tool call without deriving a label from its prompt.
 */
function parseLeaderSpec(args: unknown): { spec: LeaderSpec } | { error: string } {
  if (typeof args !== "object" || args === null) {
    return { error: "expected an object with 'title' and 'prompt'." };
  }
  const record = args as Record<string, unknown>;
  if (
    !isBoundedWorkflowString(record.prompt, WORKFLOW_LIMITS.textChars) ||
    record.prompt.length === 0
  ) {
    return {
      error:
        "'prompt' is required and must be a non-empty string no longer than " +
        `${String(WORKFLOW_LIMITS.textChars)} characters.`,
    };
  }
  if (!isBoundedWorkflowString(record.title, TASK_TITLE_MAX * 2)) {
    return { error: "title exceeds the bounded display-title size." };
  }
  const title = parseTaskTitle(record.title);
  if (!title.ok) return { error: title.message };
  const spec: LeaderSpec = {
    title: title.title,
    prompt: record.prompt,
  };
  if (record.profile !== undefined) {
    if (
      !isBoundedWorkflowString(record.profile, WORKFLOW_LIMITS.identifierChars) ||
      record.profile.length === 0
    ) {
      return {
        error:
          "'profile' must be a non-empty string no longer than " +
          `${String(WORKFLOW_LIMITS.identifierChars)} characters.`,
      };
    }
    spec.profile = record.profile;
  }
  if (typeof record.expect_schema === "object" && record.expect_schema !== null) {
    spec.expectSchema = record.expect_schema as Record<string, unknown>;
  }
  return { spec };
}
