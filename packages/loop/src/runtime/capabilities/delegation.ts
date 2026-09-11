/**
 * The lead's sub-agent spawning, packaged as a run capability. Unlike the
 * deps-level built-ins this one is constructed late — in the entry-input
 * builder, where its dependencies (opened connections, spawn semaphore, usage
 * aggregation) live — and appended to the run's capability list from there. It
 * activates only for the run's entry lead agent.
 */
import type { ImagePart, LifecycleHook } from "@clarvis/capability";
import type { EnvConfig } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import type { RegistryEntry } from "@clarvis/mcp-client";
import type { TokenLedger } from "../budget/budget.ts";
import type { Semaphore } from "../support/concurrency.ts";
import type { AgentRegistry } from "@clarvis/supervision";
import type {
  AgentCapability,
  AgentScope,
  CapabilityEventListener,
  CapabilityServices,
  RunCapability,
  SubagentCapabilitiesFactory,
} from "@clarvis/capability";
import { activationForScope } from "@clarvis/capability";
import { TASK_TRACKING_PORT } from "@clarvis/capability";
import { buildDelegationContribution } from "../delegation.ts";
import type { SubagentAggregate } from "../subagents/delegate-task.ts";
import type { SubagentProfileRegistry } from "../subagents/subagent-profiles.ts";
import type { Elicit } from "../tools/ask-user-tool.ts";

/** Registry name of the delegation (sub-agent spawning) capability. */
export const DELEGATION_CAPABILITY_NAME = "delegation";

/**
 * Everything the lead's spawn orchestration needs, assembled in the entry-input
 * builder where the opened connections, spawn semaphore and usage aggregation
 * already exist.
 */
export interface DelegationCapabilityDeps {
  env: EnvConfig;
  workspaceRoot: string;
  opened: RegistryEntry[];
  profiles: SubagentProfileRegistry;
  defaultProfile?: string;
  iterationLimitDefault: number;
  llm: LLMProvider;
  ledger: TokenLedger;
  subagentAggByModel: Map<string, SubagentAggregate>;
  semaphore: Semaphore;
  /** The run's supervision registry, when this run can spawn children. */
  agents?: AgentRegistry;
  /**
   * Whether the entry agent may actually spawn.
   *
   * @remarks Explicit, because a run can be worth activating capabilities for
   * without the entry agent holding `can_spawn` — and a solo agent offered a
   * A child-spawn tool with no profile to target is worse than no tool at all.
   */
  canDelegate: boolean;
  elicit?: Elicit;
  /** The run's other capabilities, activated per spawned subagent's grants. */
  runCapabilities?: readonly RunCapability[];
  /**
   * The run's port registry.
   *
   * @remarks How delegation reaches a task tracker, if this run has one.
   * Resolved lazily at attach time, so neither side needs to know whether the
   * other is present — let alone which package it lives in.
   */
  services?: CapabilityServices;
  hooks?: LifecycleHook[];
  logger?: Logger;
  turnImages?: ImagePart[];
  emitCapabilityEvent?: CapabilityEventListener;
  /** Wire names the run's registered capabilities own, reserved against MCP in
   * every sub-agent registry a spawn from this capability mints. */
  capabilityReserved?: readonly string[];
  /** Fleet-wide shared prompt snapshotted for this run. */
  sharedPrompt?: string;
}

/**
 * Build the entry lead's delegation capability.
 *
 * @param deps - the wiring; see {@link DelegationCapabilityDeps}.
 * @returns a {@link RunCapability} activating only for the run's entry agent,
 *   and only when `canDelegate`. Spawned subagents inherit the run's other
 *   capabilities via {@link activationForScope}.
 *
 * @remarks The contribution is advertised, like the sibling `agents`
 *   capability's. It carried `advertised: false`, which nothing could act on:
 *   the flag is read only when `mcpFullToolset !== true`, and the lead persona —
 *   the only persona this capability ever attaches to — sets it `true`.
 */
export function createDelegationRunCapability(deps: DelegationCapabilityDeps): RunCapability {
  return {
    name: DELEGATION_CAPABILITY_NAME,
    forAgent(scope: AgentScope): AgentCapability | null {
      if (!scope.entry || !deps.canDelegate) return null;
      return {
        attach(bc) {
          const capabilitiesFor: SubagentCapabilitiesFactory = (grants) =>
            activationForScope(deps.runCapabilities, {
              agent: "subagent",
              entry: false,
              grants: grants ?? [],
              ...(scope.clock ? { clock: scope.clock } : {}),
              ...(scope.signal ? { signal: scope.signal } : {}),
              ...(deps.elicit ? { elicit: deps.elicit } : {}),
            });
          const tasks = deps.services?.get(TASK_TRACKING_PORT)?.forAgent(bc);
          return {
            ...buildDelegationContribution({
              bc,
              env: deps.env,
              opened: deps.opened,
              profiles: deps.profiles,
              ...(deps.defaultProfile !== undefined ? { defaultProfile: deps.defaultProfile } : {}),
              iterationLimitDefault: deps.iterationLimitDefault,
              llm: deps.llm,
              ledger: deps.ledger,
              subagentAggByModel: deps.subagentAggByModel,
              semaphore: deps.semaphore,
              ...(deps.agents !== undefined ? { agents: deps.agents } : {}),
              ...(tasks === undefined ? {} : { tasks }),
              capabilitiesFor,
              ...(scope.clock ? { clock: scope.clock } : {}),
              workspaceRoot: deps.workspaceRoot,
              ...(deps.hooks ? { hooks: deps.hooks } : {}),
              ...(deps.logger ? { logger: deps.logger } : {}),
              ...(deps.turnImages !== undefined && deps.turnImages.length > 0
                ? { turnImages: deps.turnImages }
                : {}),
              ...(deps.capabilityReserved !== undefined
                ? { capabilityReserved: deps.capabilityReserved }
                : {}),
              ...(deps.emitCapabilityEvent === undefined
                ? {}
                : { emitCapabilityEvent: deps.emitCapabilityEvent }),
              ...(deps.sharedPrompt !== undefined ? { sharedPrompt: deps.sharedPrompt } : {}),
            }),
          };
        },
      };
    },
  };
}
