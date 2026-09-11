/**
 * Barrel for the built-in coding toolset: the tool-name sets, the grant/ceiling
 * logic, the toolset factory, and the guard/elicit surface re-exported from
 * @clarvis/tools.
 */
export { FILE_MUTATING_TOOL_NAMES } from "./names.ts";
export { agentToolCaps, agentToolsActive } from "./grants.ts";
export { createAgentToolset, type AgentToolset, type AgentToolsetOptions } from "./toolset.ts";
export { systemTemporaryRoots } from "@clarvis/tools";
export type {
  Guard,
  Elicit,
  GuardContext,
  GuardDecision,
  GuardElicitAnswer,
  GuardReview,
  ShellFacts,
  PathFact,
  ElicitRequest,
  Verdict,
} from "@clarvis/tools/guard";
export type { HostVcsDispatcher } from "@clarvis/tools";
export type { ShellDialect, Token, PathCandidate } from "@clarvis/tools/guard";
export {
  analyzeShell,
  posixDialect,
  powershellDialect,
  dialectFor,
  currentDialect,
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  WINDOWS_DEFAULT_ALLOWED_COMMANDS,
  withinWorkspace,
  touchesOutside,
} from "@clarvis/tools/guard";
