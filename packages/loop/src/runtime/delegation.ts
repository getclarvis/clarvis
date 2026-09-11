/**
 * The `delegation` capability's agent-loop contribution: independent spawning,
 * tracked task delegation, their shared handler, and inline/background paths.
 *
 * It knows nothing about what tracks its work items. The pre-spawn ruling, the
 * claim/fail surface, the batch bookkeeping and the extra half of its own tool
 * schema all arrive through an optional {@link TaskTrackingPort}, and its
 * absence simply means nothing is tracking this run.
 */
import type { EnvConfig } from "@clarvis/capability";
import type { ImagePart, LifecycleHook } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import type { RegistryEntry } from "@clarvis/mcp-client";
import type { TokenLedger } from "./budget/budget.ts";
import type { Semaphore } from "./support/concurrency.ts";
import { combineSignals } from "./support/signals.ts";
import type { AgentRegistry } from "@clarvis/supervision";
import { registerBackgroundChild } from "@clarvis/supervision";
import { partialStructOf, type AgentResult } from "./loop/loop-shared.ts";
import type { AgentBuildContext } from "./loop/run-agent.ts";
import type { HandlerVerdict, ToolHandler } from "./loop/loop-contract.ts";
import {
  DELEGATE_TASK_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  buildDelegateTaskTool,
  buildSpawnSubagentTool,
} from "./subagents/lead-tools.ts";
import {
  prepareSpawn,
  runPreparedSubagent,
  type PrepareSpawnResult,
  type DelegateTaskContext,
  type SubagentAggregate,
} from "./subagents/delegate-task.ts";
import {
  hasVisionCapableProfile,
  type SubagentProfileRegistry,
} from "./subagents/subagent-profiles.ts";
import type {
  AgentLoopContribution,
  CapabilityEventListener,
  SubagentCapabilitiesFactory,
  TaskTrackingPort,
} from "@clarvis/capability";
import type { ComputeClock } from "@clarvis/capability";

/**
 * Whether a child-spawn call asked for a background spawn.
 *
 * @param args - the raw tool arguments.
 * @returns true only for an explicit `background: true`; anything else keeps the
 *   inline path, which is the default a sub-agent should have (D4).
 */
function wantsBackground(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  return (args as { background?: unknown }).background === true;
}

/**
 * The terminal a lead hits when its background children keep failing.
 *
 * @remarks A background spawn credits progress the moment it returns a handle —
 * which is honest, the model did learn something — but that alone would let a
 * lead spawn a doomed child forever without ever tripping the no-progress guard.
 * This is the bound: consecutive failures with no success between them.
 */
function backgroundChildrenFailingTerminal(bc: AgentBuildContext): AgentResult {
  bc.trace.record("terminate", { reason: "background_children_failing" });
  return {
    status: "error",
    partialText: bc.state.lastAssistantText,
    error: {
      code: "background_children_failing",
      message:
        "Every recent background Sub-agent failed. Stopping rather than spawning another; " +
        "read one with agent_poll to see why, and finish with what you have.",
    },
    ...partialStructOf(bc.state.lastSubmitAttempt),
  };
}

/**
 * Spawn a prepared sub-agent in the background: answer the tool call with a
 * handle now, and let the registry hold the run.
 *
 * @returns an immediate `result` verdict carrying the child's `agent_id`, or a
 *   plain refusal when the registry declined to register it.
 * @remarks This is the whole fix. A `deferred` verdict would be joined by
 *   `runDispatch`'s own `finally` before the iteration could end, so the parent
 *   would stay blocked exactly as before; only an immediate `result` answers the
 *   `tool_use` and lets iteration N+1 — and with it the steer drain — happen.
 *   The semaphore `acquire` therefore moves inside the registry's task rather
 *   than out of the verdict: a child still queued for a slot no longer holds the
 *   dispatch. It takes the child's combined signal, so a stop while queued
 *   rejects the acquire and never grants a permit to abandon.
 */
function spawnInBackground(
  toolName: string,
  agents: AgentRegistry,
  prepared: Parameters<typeof runPreparedSubagent>[0],
  spawnCtx: DelegateTaskContext,
  deps: DelegationDeps,
  bc: AgentBuildContext,
): HandlerVerdict {
  const spawned = registerBackgroundChild(agents, bc.trace, {
    kind: "subagent",
    nativeId: prepared.subagentInstanceId,
    title: prepared.subagentTask,
    profile: prepared.selectedProfile.name,
  });

  if (spawned === null) {
    return {
      kind: "result",
      text:
        `Tool '${toolName}' result: not spawned — too many child agents are already running. ` +
        "Wait with await_agents or end one with agent_stop, then try again.",
      progress: false,
    };
  }
  const { handle, controller, steerQueue } = spawned;

  const task = (async (): Promise<void> => {
    const combined = combineSignals(bc.signal, controller.signal);
    let permitHeld = false;
    let region: ReturnType<NonNullable<typeof deps.clock>["enterBackground"]> | undefined;
    try {
      await deps.semaphore.acquire(combined);
      permitHeld = true;
      region = deps.clock?.enterBackground();
      const outcome = await runPreparedSubagent(prepared, {
        ...spawnCtx,
        ...(combined !== undefined ? { signal: combined } : {}),
        steer: steerQueue,
        ...(region !== undefined ? { computeRegion: region } : {}),
      });
      handle.settled({
        status: outcome.failed ? "failed" : "completed",
        result: outcome.text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handle.settled({
        status: combined?.aborted === true ? "stopped" : "failed",
        result: combined?.aborted === true ? "cancelled before it finished" : message,
      });
    } finally {
      region?.leave();
      if (permitHeld) deps.semaphore.release();
      steerQueue.close();
    }
  })();
  agents.adopt(handle.id, task);

  return {
    kind: "result",
    text:
      `Tool '${toolName}' result: started ${handle.id} in the background. ` +
      "It is running now — keep working, then collect it with await_agents (to wait) or " +
      "agent_poll (to look). Do not finish until it has returned.",
    progress: true,
  };
}

/**
 * Everything {@link buildDelegationContribution} needs: the agent build context
 * and env, the opened MCP pool, the sub-agent profile registry, budgets/ledger
 * and concurrency semaphore, and the various optional ports (task tracking,
 * capabilities factory, clock, hooks, turn images, logger).
 *
 * @remarks `tasks` is the only coupling to a tracker, and it is optional by
 *   design. Without it the run advertises only `spawn_subagent`; with it the
 *   run also advertises `delegate_task` and applies the tracker's gate to both.
 */
export interface DelegationDeps {
  bc: AgentBuildContext;
  env: EnvConfig;
  opened: RegistryEntry[];
  profiles: SubagentProfileRegistry;
  defaultProfile?: string;
  iterationLimitDefault: number;
  llm: LLMProvider;
  ledger: TokenLedger;
  subagentAggByModel: Map<string, SubagentAggregate>;
  semaphore: Semaphore;
  /** The run's supervision registry, when this run can spawn. Its absence is
   * what makes `background: true` degrade to an inline spawn rather than fail. */
  agents?: AgentRegistry;
  /** The task-tracking seam, when something tracks this run's work items. */
  tasks?: TaskTrackingPort;
  capabilitiesFor?: SubagentCapabilitiesFactory;
  clock?: ComputeClock;
  workspaceRoot?: string;
  hooks?: LifecycleHook[];
  turnImages?: ImagePart[];
  logger?: Logger;
  emitCapabilityEvent?: CapabilityEventListener;
  /** Wire names the run's registered capabilities own, reserved against MCP in
   * every sub-agent registry this contribution's spawns mint. */
  capabilityReserved?: readonly string[];
  /** Fleet-wide shared prompt snapshotted for this run. */
  sharedPrompt?: string;
}

/**
 * Per-iteration delegation state, reset each `beforeIteration`: whether a
 * sub-agent spawned successfully, which is this capability's whole contribution
 * to the loop's progress signal.
 */
interface IterState {
  subagentSpawned: boolean;
}

/**
 * Build the lead's child-spawn contribution.
 *
 * The handler enforces the tracker's pre-spawn ruling (when one is present),
 * then runs each prepared sub-agent under the concurrency semaphore
 * and compute clock — inline by default, or in the background when the call
 * asked for it and the run has a supervision registry.
 *
 * @param deps - the wiring; see {@link DelegationDeps}.
 * @returns the delegation {@link AgentLoopContribution}.
 */
export function buildDelegationContribution(deps: DelegationDeps): AgentLoopContribution {
  const { bc } = deps;
  const { trace } = bc;
  const imageRefsAllowed =
    (deps.turnImages?.length ?? 0) > 0 && hasVisionCapableProfile(deps.profiles.values());

  let iter: IterState = { subagentSpawned: false };

  const spawnCtx: DelegateTaskContext = {
    env: deps.env,
    opened: deps.opened,
    profiles: deps.profiles,
    ...(deps.defaultProfile !== undefined ? { defaultProfile: deps.defaultProfile } : {}),
    iterationLimitDefault: deps.iterationLimitDefault,
    llm: deps.llm,
    ledger: deps.ledger,
    trace,
    subagentAggByModel: deps.subagentAggByModel,
    ...(bc.signal ? { signal: bc.signal } : {}),
    ...(deps.tasks ? { tasks: deps.tasks } : {}),
    ...(deps.capabilitiesFor ? { capabilitiesFor: deps.capabilitiesFor } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.turnImages ? { turnImages: deps.turnImages } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.emitCapabilityEvent ? { emitCapabilityEvent: deps.emitCapabilityEvent } : {}),
    ...(deps.capabilityReserved ? { capabilityReserved: deps.capabilityReserved } : {}),
    ...(deps.sharedPrompt !== undefined ? { sharedPrompt: deps.sharedPrompt } : {}),
  };

  const spawnHandler: ToolHandler = {
    matches: (call) =>
      call.name === SPAWN_SUBAGENT_TOOL_NAME ||
      (deps.tasks !== undefined && call.name === DELEGATE_TASK_TOOL_NAME),
    async handle(call): Promise<HandlerVerdict> {
      const tracked = call.name === DELEGATE_TASK_TOOL_NAME;
      const toolName = tracked ? DELEGATE_TASK_TOOL_NAME : SPAWN_SUBAGENT_TOOL_NAME;
      const rawArgs = call.arguments;
      const rawTaskId =
        typeof rawArgs === "object" && rawArgs !== null
          ? (rawArgs as Record<string, unknown>).task_id
          : undefined;
      const callTaskId =
        tracked && typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : undefined;

      const gate = await deps.tasks?.beforeSpawn(callTaskId);
      if (gate?.kind === "terminal") return { kind: "terminal", result: gate.result };
      if (gate?.kind === "refuse") {
        return {
          kind: "result",
          text: `Tool '${toolName}' result: ${gate.text}`,
          progress: false,
        };
      }

      let prep: PrepareSpawnResult;
      const callCtx: DelegateTaskContext = {
        ...spawnCtx,
        toolName,
        requireTaskId: tracked,
      };
      try {
        prep = await prepareSpawn(rawArgs, callCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: "result",
          text: `Tool '${toolName}' result: ${toolName} error: ${msg}`,
          progress: false,
        };
      }
      if (!prep.ok) {
        return {
          kind: "result",
          text: `Tool '${toolName}' result: ${prep.text}`,
          progress: false,
        };
      }
      const prepared = prep.prepared;
      if (prepared.taskId !== undefined) deps.tasks?.noteSpawned(prepared.taskId);

      if (wantsBackground(rawArgs) && deps.agents !== undefined) {
        if (deps.agents.failingStreakExceeded()) {
          return { kind: "terminal", result: backgroundChildrenFailingTerminal(bc) };
        }
        return spawnInBackground(toolName, deps.agents, prepared, callCtx, deps, bc);
      }

      return {
        kind: "deferred",
        run: async (signal) => {
          const effective = signal ?? bc.signal;
          let permitHeld = false;
          let entered = false;
          try {
            await deps.semaphore.acquire(effective);
            permitHeld = true;
            deps.clock?.enter();
            entered = true;
            const r = await runPreparedSubagent(
              prepared,
              effective !== undefined ? { ...callCtx, signal: effective } : callCtx,
            );
            if (!r.failed) iter.subagentSpawned = true;
            return {
              text: `Tool '${toolName}' result: ${r.text}`,
              progress: false,
              ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              text: effective?.aborted
                ? `Tool '${toolName}' result: Sub-agent cancelled.`
                : `Tool '${toolName}' result: Sub-agent error: ${msg}`,
              progress: false,
            };
          } finally {
            if (entered) deps.clock?.leave();
            if (permitHeld) deps.semaphore.release();
          }
        },
      };
    },
  };

  return {
    tools: [
      buildSpawnSubagentTool(deps.profiles, imageRefsAllowed),
      ...(deps.tasks === undefined
        ? []
        : [
            buildDelegateTaskTool(
              deps.profiles,
              imageRefsAllowed,
              deps.tasks.augmentDelegateTask(),
            ),
          ]),
    ],
    handlers: [spawnHandler],
    hooks: {
      beforeIteration: () => {
        iter = { subagentSpawned: false };
      },
      contributesProgress: () => iter.subagentSpawned,
    },
  };
}
