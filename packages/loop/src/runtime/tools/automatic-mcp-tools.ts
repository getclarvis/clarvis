import type { McpServerConfig } from "@clarvis/capability";
import { poolToolNames, type RegistryEntry } from "./mcp-registry.ts";
import type { ResolvedSubagentProfile } from "../subagents/subagent-profiles.ts";

/**
 * Add every tool discovered from an `auto_tools` server to every resolved
 * profile for this run.
 *
 * @param servers - the validated server descriptors from the immutable run request.
 * @param opened - connections that actually opened, with their discovered tools.
 * @param profiles - resolved profiles mutated before any agent registry is built.
 * @returns the exact dotted tool names admitted automatically, in pool order.
 * @remarks A failed server contributes nothing: startup degradation has already
 * removed it from `opened`. Persisted agent profiles and the request's profile
 * DTOs remain unchanged; only the resolved per-run profiles receive this union.
 */
export function addAutomaticMcpTools(
  servers: readonly McpServerConfig[],
  opened: RegistryEntry[],
  profiles: Iterable<ResolvedSubagentProfile>,
): string[] {
  const automaticServers = new Set(
    servers.filter((server) => server.auto_tools === true).map((server) => server.name),
  );
  if (automaticServers.size === 0) return [];

  const automaticTools = poolToolNames(
    opened.filter((entry) => automaticServers.has(entry.conn.name)),
  );
  if (automaticTools.length === 0) return [];

  for (const profile of profiles) {
    profile.tools = [...new Set([...profile.tools, ...automaticTools])];
  }
  return automaticTools;
}
