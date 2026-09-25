/**
 * The `delegation` capability's agent-loop contribution: independent spawning
 * through inline and background paths.
 *
 * An optional {@link SpawnGatePort} supplies a pre-spawn ruling.
 */
import type { EnvConfig } from "@clarvis/capability";
import type { WorkspaceStatePaths } from "@clarvis/paths";
import type { ImagePart, LifecycleHook } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import type { RegistryEntry } from "@clarvis/mcp-client";
import type { TokenLedger } from "./budget/budget.ts";
import type { Semaphore } from "./support/concurrency.ts";
import { combineSignals } from "./support/signals.ts";
import type { AgentRegistry } from "@clarvis/supervision";
import { registerBackgroundChild } from "@clarvis/supervision";
import type { AgentBuildContext } from "./loop/run-agent.ts";
import type { HandlerVerdict, ToolHandler } from "./loop/loop-contract.ts";
import { SPAWN_SUBAGENT_TOOL_NAME, buildSpawnSubagentTool } from "./subagents/lead-tools.ts";
import {
  prepareSpawn,
  runPreparedSubagent,
  settlementStatusOf,
  type PrepareSpawnResult,
  type SpawnContext,
  type SpawnResult,
  type SubagentAggregate,
} from "./subagents/spawn-subagent.ts";
import {
  hasVisionCapableProfile,
  type SubagentProfileRegistry,
} from "./subagents/subagent-profiles.ts";
import type {
  AgentLoopContribution,
  CapabilityEventListener,
  SubagentCapabilitiesFactory,
  SpawnGatePort,
} from "@clarvis/capability";
import type { ComputeClock } from "@clarvis/capability";
import type { ToolInterruptRegistry } from "./tools/tool-interrupt.ts";

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
 * The refusal a lead gets while its children keep failing technically.
 *
 * @param toolName - the child-spawn tool that was called.
 * @param failures - the consecutive technical failures seen so far.
 * @returns a plain refusal that credits no progress.
 * @remarks A refusal, not a terminal verdict. A streak of child failures is a
 *   fact about children, and the smallest scope that contains it is the child
 *   admission it closes — ending the run there, which is what used to happen, also
 *   cancelled every healthy sibling and every running inference in the tree. The
 *   lead keeps its own iteration to inspect a child with `agent_poll`, take the
 *   work over locally, or finish with what it has. What still bounds a lead that
 *   only repeats the call is the progress tracker: a refusal credits no progress,
 *   so the `no_progress` guard ends the run with the model's own repetition as the
 *   evidence. Asking again does not reset the streak either — only a child that
 *   finishes successfully does.
 */
function spawnRefusedByStreak(toolName: string, failures: number): HandlerVerdict {
  return {
    kind: "result",
    text:
      `Tool '${toolName}' result: not spawned — the last ${String(failures)} Sub-agents failed. ` +
      "Read one with agent_poll, do the work here, or finish with what you have.",
    progress: false,
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
  spawnCtx: SpawnContext,
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
        "Inspect children with agent_poll or end one with agent_stop, then try again.",
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
        status: settlementStatusOf(outcome.outcome),
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
      "It is running now — keep working, then inspect it with agent_poll or read its " +
      "completion notice. Do not finish until it has returned.",
    progress: true,
  };
}

/**
 * Everything {@link buildDelegationContribution} needs: the agent build context
 * and env, the opened MCP pool, the sub-agent profile registry, budgets/ledger
 * and concurrency semaphore, and the optional ports (spawn gate,
 * capabilities factory, clock, hooks, turn images, logger).
 *
 * @remarks The optional spawn gate can refuse a call before child preparation.
 */
export interface DelegationDeps {
  /** Inherited host-resolved machinery namespace. */
  statePaths?: WorkspaceStatePaths;
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
  /** Optional gate for child spawning. */
  spawnGate?: SpawnGatePort;
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
  /** Shared run-local interrupt registry for child shells. */
  toolInterrupts?: ToolInterruptRegistry;
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

  const spawnCtx: SpawnContext = {
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
    ...(deps.capabilitiesFor ? { capabilitiesFor: deps.capabilitiesFor } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
    ...(deps.statePaths === undefined ? {} : { statePaths: deps.statePaths }),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.turnImages ? { turnImages: deps.turnImages } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.emitCapabilityEvent ? { emitCapabilityEvent: deps.emitCapabilityEvent } : {}),
    ...(deps.capabilityReserved ? { capabilityReserved: deps.capabilityReserved } : {}),
    ...(deps.sharedPrompt !== undefined ? { sharedPrompt: deps.sharedPrompt } : {}),
    ...(deps.toolInterrupts !== undefined ? { toolInterrupts: deps.toolInterrupts } : {}),
  };

  const spawnHandler: ToolHandler = {
    matches: (call) => call.name === SPAWN_SUBAGENT_TOOL_NAME,
    async handle(call): Promise<HandlerVerdict> {
      const toolName = SPAWN_SUBAGENT_TOOL_NAME;
      const rawArgs = call.arguments;

      const gate = await deps.spawnGate?.beforeSpawn();
      if (gate?.kind === "terminal") return { kind: "terminal", result: gate.result };
      if (gate?.kind === "refuse") {
        return {
          kind: "result",
          text: `Tool '${toolName}' result: ${gate.text}`,
          progress: false,
        };
      }

      if (
        deps.agents !== undefined &&
        deps.agents.failingStreakExceeded() &&
        (!wantsBackground(rawArgs) || !deps.agents.claimFailureProbe())
      ) {
        return spawnRefusedByStreak(toolName, deps.agents.consecutiveFailures());
      }

      let prep: PrepareSpawnResult;
      const callCtx: SpawnContext = {
        ...spawnCtx,
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

      if (wantsBackground(rawArgs) && deps.agents !== undefined) {
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
            const r: SpawnResult = await runPreparedSubagent(
              prepared,
              effective !== undefined ? { ...callCtx, signal: effective } : callCtx,
            );
            if (r.outcome === "completed") iter.subagentSpawned = true;
            return {
              text: `Tool '${toolName}' result: ${r.text}`,
              progress: false,
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
    tools: [buildSpawnSubagentTool(deps.profiles, imageRefsAllowed)],
    handlers: [spawnHandler],
    hooks: {
      beforeIteration: () => {
        iter = { subagentSpawned: false };
      },
      contributesProgress: () => iter.subagentSpawned,
    },
  };
}
