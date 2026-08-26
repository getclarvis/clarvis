import type { AuthConfig, RolePermissions } from "./auth-config.ts";

/** An authenticated caller, resolved from the config file rather than from its token. */
export interface Principal {
  readonly clientId: string;
  readonly owner: string;
  readonly role: string;
  readonly permissions: RolePermissions;
}

/** Why a token that verified cryptographically still does not identify a caller. */
export type PrincipalRejection = "unknown_client" | "disabled_client";

/**
 * Resolve a verified token's subject into the caller it stands for.
 *
 * @param config - the current auth configuration.
 * @param clientId - the token's `sub`.
 * @returns the {@link Principal}, or the reason it was refused.
 * @remarks Resolution happens on **every** request, against the file as it is
 *   now — which is the whole reason a token carries no owner and no role.
 *   Deleting or disabling a client therefore invalidates its outstanding tokens
 *   immediately, instead of leaving a window as long as the token lifetime in
 *   which a revoked caller keeps its grant.
 */
export function resolvePrincipal(
  config: AuthConfig,
  clientId: string,
): { ok: true; principal: Principal } | { ok: false; reason: PrincipalRejection } {
  const client = config.clients.find((candidate) => candidate.clientId === clientId);
  if (client === undefined) return { ok: false, reason: "unknown_client" };
  if (client.disabled) return { ok: false, reason: "disabled_client" };
  const permissions = config.roles[client.role];
  if (permissions === undefined) return { ok: false, reason: "unknown_client" };
  return {
    ok: true,
    principal: {
      clientId: client.clientId,
      owner: client.owner,
      role: client.role,
      permissions,
    },
  };
}

/**
 * Whether a principal may run a named agent.
 *
 * @param principal - the authenticated caller.
 * @param agent - the `agent` argument of `clarvis_run`, absent when the caller
 *   let the container's default apply.
 * @returns `true` when the run may proceed.
 * @remarks A role holding an explicit allowlist **requires** the argument. The
 *   facade cannot know which agent an omitted argument resolves to — that is the
 *   kernel's configuration — so accepting the omission would let any caller
 *   reach the default agent and make the allowlist decorative.
 */
export function mayRunAgent(principal: Principal, agent: string | undefined): boolean {
  const { agents } = principal.permissions;
  if (agents === "*") return true;
  return agent !== undefined && agents.includes(agent);
}
