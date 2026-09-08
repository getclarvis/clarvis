import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENTS_DIR } from "./constants.ts";
import { globalPaths } from "./global.ts";
import { workspacePaths } from "./workspace.ts";

/** The four operator-selected configuration scopes offered by native self configuration. */
export type ConfigurationRoot =
  "global_clarvis" | "workspace_clarvis" | "global_agents" | "workspace_agents";

/** Resolve configuration roots without creating directories or granting access to their contents. */
export function configurationRoots(options: {
  workspaceRoot: string;
  globalDir?: string;
  home?: string;
}): Readonly<Record<ConfigurationRoot, string>> {
  return {
    global_clarvis: resolve(globalPaths(options.globalDir).root),
    workspace_clarvis: resolve(workspacePaths(options.workspaceRoot).clarvisDir),
    global_agents: resolve(join(options.home ?? homedir(), AGENTS_DIR)),
    workspace_agents: resolve(join(options.workspaceRoot, AGENTS_DIR)),
  };
}
