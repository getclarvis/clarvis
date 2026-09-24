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
  probeBubblewrap,
  probeSeatbelt,
  probeSandbox,
  sandboxCommand,
  discoverToolchains,
  TOOLCHAIN_COMMANDS,
} from "@clarvis/tools/sandbox";
export type {
  SandboxProbe,
  BubblewrapProbe,
  SeatbeltProbe,
  DiscoveredToolchain,
  ToolchainId,
} from "@clarvis/tools/sandbox";
export {
  resolveShell,
  shellArgs,
  currentShellFlavor,
  executableOnPath,
  resolveCommand,
  killTree,
  ownProcessGroup,
} from "@clarvis/tools";
export type { ShellSpec, ShellDeps, ShellFlavor } from "@clarvis/tools";
export {
  discoverSandboxToolchains,
  resolveSandboxHostPolicy,
  resolveSandboxPath,
} from "./runtime/capabilities/sandbox-host-policy.ts";
export type { ResolvedSandboxPath } from "./runtime/capabilities/sandbox-host-policy.ts";
