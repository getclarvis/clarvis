import type { StartRunParams } from "@clarvis/protocol";
import type { LeaderProfileInfo } from "@clarvis/workflows";
import { resolveAgentsByName } from "../config/agent-resolution.ts";
import type { ConfigStore } from "../config/config-store.ts";
import type { SkillsProvider } from "@clarvis/loop";
import { skillEntryAgent } from "../skills/render-skill-prompt.ts";

/** Agent-profile policy used while constructing owner workflow services. */
export interface AgentWorkflowPolicy {
  /** Profiles a manager may select as leaders. */
  leaderProfiles(): readonly LeaderProfileInfo[];
  /**
   * Whether a start request will enter on a manager profile carrying the
   * workflow grant.
   *
   * @remarks Resolves a skill's own entry agent first. A skill declaring
   *   `agent: "<name>"` overrides `params.agent` in the request
   *   assembler, but routing happens before the assembler runs — so asking only
   *   about `params.agent` sent a skill that names a manager down the ordinary
   *   path. The assembler then made that manager the entry profile anyway, and
   *   because the workflows capability is only injected on the manager path the
   *   agent ran its own prompt with no `run_leader` tool: told to fan out, and
   *   unable to. Silent, and only visible as a manager that never delegates.
   */
  isManagerRun(params: StartRunParams): boolean;
  /** Default leader profile declared by a manager's `default_spawn`. */
  resolveLeaderDefault(managerAgent?: string): string | undefined;
}

/**
 * Build workflow-agent policy over the live config store.
 *
 * @param store - settings and agent source re-read on every decision.
 * @param skills - the skills source, so a skill's declared entry agent is known
 *   at routing time; omitted when the host configured none.
 * @returns an independently testable resolver for manager and leader policy.
 */
export function createAgentWorkflowPolicy(
  store: Pick<ConfigStore, "listAgents">,
  skills?: SkillsProvider,
): AgentWorkflowPolicy {
  const frontmatterOf = (name: string | undefined): Record<string, unknown> | undefined =>
    name === undefined
      ? undefined
      : resolveAgentsByName(store.listAgents()).find((agent) => agent.name === name)?.frontmatter;

  return {
    leaderProfiles(): readonly LeaderProfileInfo[] {
      return resolveAgentsByName(store.listAgents())
        .filter((agent) => {
          const grants = agent.frontmatter.grants;
          return !(Array.isArray(grants) && grants.includes("workflow"));
        })
        .map((agent) => ({
          name: agent.name,
          ...(agent.description !== undefined ? { description: agent.description } : {}),
        }));
    },
    isManagerRun(params): boolean {
      const skillAgent =
        params.skill === undefined
          ? undefined
          : skillEntryAgent(skills?.loadSkill(params.skill.name)?.metadata);
      const grants = frontmatterOf(skillAgent ?? params.agent)?.grants;
      return Array.isArray(grants) && grants.includes("workflow");
    },
    resolveLeaderDefault(managerAgent): string | undefined {
      const spawn = frontmatterOf(managerAgent)?.default_spawn;
      if (typeof spawn === "string") return spawn;
      if (Array.isArray(spawn) && typeof spawn[0] === "string") return spawn[0];
      return undefined;
    },
  };
}
