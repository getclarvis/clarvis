import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { globalPaths, workspaceStatePaths } from "@clarvis/paths";
import type { PluginRef } from "@clarvis/protocol";

/** Resolve the persistent client-managed data directory for one plugin instance. */
export function pluginDataDir(options: {
  globalDir: string;
  workspaceRoot?: string;
  ref: PluginRef;
}): string {
  const root =
    options.ref.scope === "global"
      ? globalPaths(options.globalDir).pluginDataRoot
      : options.workspaceRoot === undefined
        ? undefined
        : workspaceStatePaths(options.workspaceRoot, {
            env: { CLARVIS_HOME: options.globalDir },
          }).pluginDataRoot;
  if (root === undefined) {
    throw new Error("workspace plugin data requires a workspace root");
  }
  return join(root, options.ref.source, options.ref.name);
}

/** Create the persistent data directory before an active plugin subprocess can launch. */
export function ensurePluginDataDir(options: {
  globalDir: string;
  workspaceRoot?: string;
  ref: PluginRef;
}): string {
  const dir = pluginDataDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
