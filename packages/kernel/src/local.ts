/** Local process, shell, executable, filesystem, and git adapters. */
export {
  probeBubblewrap,
  sandboxCommand,
  discoverToolchains,
  TOOLCHAIN_COMMANDS,
} from "@clarvis/tools/sandbox";
export type { BubblewrapProbe, DiscoveredToolchain, ToolchainId } from "@clarvis/tools/sandbox";
export {
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  WINDOWS_DEFAULT_ALLOWED_COMMANDS,
} from "@clarvis/tools/guard";
export {
  resolveShell,
  shellArgs,
  exitCaptureWrapper,
  currentShellFlavor,
  killTree,
  ownProcessGroup,
} from "@clarvis/tools/shell";
export type { ShellSpec, ShellFlavor } from "@clarvis/tools/shell";
export { resolveCommand, executableOnPath } from "@clarvis/paths";
export { withoutGitRepositoryEnvironment } from "@clarvis/paths";
export { createNodeProcessRunner } from "./adapters/process/node-process-runner.ts";
export type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "./ports/process-runner.ts";
export { createFilePluginRepository } from "./adapters/filesystem/plugin-repository.ts";
export { createGitPluginFetcher } from "./adapters/git/plugin-fetcher.ts";
export type { FilePluginRepositoryOptions } from "./adapters/filesystem/plugin-repository.ts";
export type { GitPluginFetcherOptions } from "./adapters/git/plugin-fetcher.ts";
export type {
  InstalledPlugin,
  PluginFetcher,
  PluginRepository,
  PreparedPlugin,
} from "./ports/plugin-repository.ts";
export {
  createCapabilityExecutableSessionManager,
  type CapabilityExecutableSessionManager,
  type CapabilityExecutableSessionManagerOptions,
} from "./capability-executables/session-manager.ts";
