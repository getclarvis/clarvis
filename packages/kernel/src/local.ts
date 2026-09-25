/** Local process, shell, executable, filesystem, and git adapters. */
export { resolveShell, shellArgs, killTree, ownProcessGroup } from "@clarvis/tools/shell";
export type { ShellSpec } from "@clarvis/tools/shell";
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
