/**
 * Barrel for the built-in coding toolset: the tool-name sets, the grant/ceiling
 * logic and the toolset factory.
 */
export { FILE_MUTATING_TOOL_NAMES } from "./names.ts";
export { agentToolCaps, agentToolsActive } from "./grants.ts";
export { createAgentToolset, type AgentToolset, type AgentToolsetOptions } from "./toolset.ts";
export { systemTemporaryRoots } from "@clarvis/tools";
