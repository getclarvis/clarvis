import { resolveConfig } from "./config.ts";
import { dispatch, listTools } from "./core.ts";
import type { AgentToolsOptions, RuntimeConfig } from "./config.ts";
import type { DispatchResult, ToolInfo } from "./core.ts";

/**
 * The library entry surface: a resolved config plus the two operations a host
 * needs to drive the tools - list what is available and call one. A thin
 * facade over {@link listTools} and {@link dispatch} bound to a single config.
 */
export interface AgentTools {
  /** The resolved {@link RuntimeConfig} these tools were built with. */
  readonly config: RuntimeConfig;

  /** List the tools available under {@link AgentTools.config}. */
  listTools(): ToolInfo[];

  /**
   * Invoke a tool by name.
   *
   * @param name - the tool to call.
   * @param args - the arguments object; defaults to `{}`.
   * @returns the {@link DispatchResult}; failures are in-band, never thrown.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<DispatchResult>;
}

/**
 * Build an {@link AgentTools} instance for a workspace.
 *
 * @param options - the {@link AgentToolsOptions} (only `workspaceRoot` is
 *   required); resolved and validated via {@link resolveConfig}.
 * @returns a facade whose `listTools`/`callTool` are bound to the resolved config.
 * @throws {@link StartupError} when {@link resolveConfig} rejects the options.
 */
export function createAgentTools(options: AgentToolsOptions): AgentTools {
  const config = resolveConfig(options);
  return {
    config,
    listTools: () => listTools(config),
    callTool: (name, args = {}) => dispatch(name, args, config),
  };
}

export { dispatch, listTools } from "./core.ts";
export type { DispatchResult, ToolInfo } from "./core.ts";

export {
  resolveConfig,
  StartupError,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TRAVERSAL_ENTRIES,
  DEFAULT_MAX_MUTATION_BYTES,
  DEFAULT_MAX_DIFF_INPUT_BYTES,
  DEFAULT_MAX_TOOL_META_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_SHELL_TIMEOUT_MAX_MS,
  DEFAULT_MONITOR_READY_TIMEOUT_MS,
  DEFAULT_MAX_MONITORS,
  DEFAULT_REGEX_SCAN_BUDGET_MS,
} from "./config.ts";
export type { RuntimeConfig, AgentToolsOptions } from "./config.ts";
export type { SandboxConfig } from "./sandbox.ts";
export { systemTemporaryRoots } from "./sandbox.ts";
export {
  resolveShell,
  shellArgs,
  encodePowerShellCommand,
  exitCaptureWrapper,
  currentShellFlavor,
} from "./shell.ts";
export type { ShellSpec, ShellDeps, ShellFlavor } from "./shell.ts";
export { executableOnPath, resolveCommand } from "@clarvis/paths";
export { killTree, ownProcessGroup } from "./lib/process.ts";
export type { KillDeps, TaskkillRunner } from "./lib/process.ts";

export { tools, readOnlyTools, getTool, selectSurface } from "./tools/registry.ts";
export type { ToolDef, ToolCallHooks } from "./tools/types.ts";

export {
  analyzeShell,
  posixDialect,
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  WINDOWS_DEFAULT_ALLOWED_COMMANDS,
  buildGuardContext,
  withinWorkspace,
  touchesOutside,
} from "./guard/index.ts";
export type {
  Verdict,
  GuardDecision,
  GuardAnswerer,
  GuardElicitAnswer,
  GuardReview,
  Segment,
  ShellFacts,
  PathFact,
  GuardContext,
  Guard,
  ElicitRequest,
  Elicit,
  ShellDialect,
  Token,
  PathCandidate,
} from "./guard/index.ts";
export type { ContentPart, TextPart, ImagePart, ToolResult } from "./tools/content.ts";
export { contentText } from "./tools/content.ts";

export { ToolError, serializeError, fsError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

export { sweepMonitors } from "./lib/monitor.ts";

export { setWarnSink, warn, NOOP_TOOLS_LOGGER } from "./lib/log.ts";
export type { WarnSink, ToolsLogger, ToolsWarning } from "./lib/log.ts";
