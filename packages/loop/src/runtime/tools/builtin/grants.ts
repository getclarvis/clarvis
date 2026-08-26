import type { EnvConfig } from "@clarvis/capability";

/**
 * The deployment-wide ceiling on how far an agent's tool grants may reach,
 * ordered `none` < `read` < `edit` < `exec`; it caps but never widens what the
 * agent's own grants request.
 *
 * @remarks Not exported beyond this file: no consumer outside
 * {@link agentToolCaps} and {@link agentToolsActive} needs to name it.
 */
type GrantCeiling = "none" | "read" | "edit" | "exec";

/**
 * The effective coding-tool capabilities of an agent after intersecting its
 * requested grants with the {@link GrantCeiling}: read, mutate and exec.
 *
 * @remarks Not exported beyond this file: {@link agentToolCaps} is the only
 * public surface, and its callers consume the fields, never the type name.
 */
interface AgentToolCaps {
  canRead: boolean;
  canMutate: boolean;
  canExec: boolean;
}

const CEILING_RANK: Record<GrantCeiling, number> = { none: 0, read: 1, edit: 2, exec: 3 };

/**
 * Resolve an agent's effective {@link AgentToolCaps} by intersecting its requested
 * `grants` with the deployment `ceiling`.
 *
 * @param grants - the agent's grant strings (`read_workspace`, `edit_workspace`,
 *   `run_commands`); treated as empty when omitted.
 * @param ceiling - the maximum reach allowed regardless of grants.
 * @returns the capabilities actually available: `edit_workspace`/`run_commands`
 *   imply read, `run_commands` implies mutate, and each is further gated by the
 *   ceiling's rank.
 */
export function agentToolCaps(
  grants: readonly string[] | undefined,
  ceiling: GrantCeiling,
): AgentToolCaps {
  const g = grants ?? [];
  const wantsRead =
    g.includes("read_workspace") || g.includes("edit_workspace") || g.includes("run_commands");
  const wantsMutate = g.includes("edit_workspace") || g.includes("run_commands");
  const wantsExec = g.includes("run_commands");
  const cap = CEILING_RANK[ceiling];
  return {
    canRead: wantsRead && cap >= CEILING_RANK.read,
    canMutate: wantsMutate && cap >= CEILING_RANK.edit,
    canExec: wantsExec && cap >= CEILING_RANK.exec,
  };
}

/**
 * Whether the built-in coding toolset is active for an agent with these grants.
 * Lives here (dep-free grant logic, no @clarvis/tools import) so the core
 * loop can gate persona wording / accounting / vision on it without pulling the
 * optional tools package; the capability re-exports it. The persona
 * builders key their "has built-in tools" wording (and the all-tools-unavailable
 * check) on this same gate.
 */
export function agentToolsActive(env: EnvConfig, grants: readonly string[] | undefined): boolean {
  if (!env.CLARVIS_AGENT_TOOLS_ENABLED) return false;
  return agentToolCaps(grants, env.CLARVIS_AGENT_TOOLS_MAX_GRANT).canRead;
}
