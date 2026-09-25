/**
 * Subpath entrypoint `@clarvis/loop/capabilities/tools`.
 *
 * The built-in coding toolset capability (@clarvis/tools). Kept off the main entrypoint so `import "@clarvis/loop"`
 * carries no static dependency on the optional @clarvis/tools package;
 * import this subpath only when you wire the tools capability yourself.
 */
export {
  createAgentToolsCapability,
  AGENT_TOOLS_CAPABILITY_NAME,
  agentToolsActive,
} from "./runtime/capabilities/tools.ts";
export type { AgentToolsCapabilityOptions } from "./runtime/capabilities/tools.ts";
export { FILE_MUTATING_TOOL_NAMES } from "./runtime/tools/builtin/index.ts";
export {
  resolveShell,
  shellArgs,
  executableOnPath,
  resolveCommand,
  killTree,
  ownProcessGroup,
} from "@clarvis/tools";
export type { ShellSpec } from "@clarvis/tools";
