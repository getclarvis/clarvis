import { lstatSync } from "node:fs";
import {
  configurationRoots,
  configurationTarget,
  DIR_MODE,
  FILE_MODE,
  type ConfigurationRoot,
} from "@clarvis/paths";
import type { RuntimeConfig } from "../config.ts";

/** Shared classification after guard path resolution; metadata never grants access. */
export function isCanonicalAuthoringPath(path: string, workspaceRoot: string): boolean {
  const roots = configurationRoots({ workspaceRoot });
  return (
    configurationTarget(
      { workspace_clarvis: roots.workspace_clarvis, workspace_agents: roots.workspace_agents },
      path,
    )?.kind === "authoring"
  );
}

/** A workspace configuration leaf that may reach the host's prepared mutation review. */
export function isReviewedConfigurationPath(
  path: string,
  workspaceRoot: string,
  roots: Readonly<Partial<Record<ConfigurationRoot, string>>> = {
    workspace_clarvis: configurationRoots({ workspaceRoot }).workspace_clarvis,
    workspace_agents: configurationRoots({ workspaceRoot }).workspace_agents,
  },
): boolean {
  const target = configurationTarget(roots, path);
  return target?.kind === "authoring" || target?.kind === "operational";
}

/** Reviewed configuration uses the restricted writer's private creation modes. */
export function reviewedConfigurationModes(
  path: string,
  config: Pick<RuntimeConfig, "workspaceRoot" | "configurationRoots" | "reviewMutation">,
): { mode: number; dirMode: number } | undefined {
  return config.reviewMutation !== undefined &&
    isReviewedConfigurationPath(path, config.workspaceRoot, config.configurationRoots)
    ? { mode: FILE_MODE, dirMode: DIR_MODE }
    : undefined;
}

/** A recursive replacement may discover admitted configuration leaves below a protected directory.
 * The handler filters leaves before reads and the host reviews the complete prepared batch.
 */
export function isAuthoringSearchScope(
  path: string,
  workspaceRoot: string,
  roots: Readonly<Partial<Record<ConfigurationRoot, string>>> = {
    workspace_clarvis: configurationRoots({ workspaceRoot }).workspace_clarvis,
    workspace_agents: configurationRoots({ workspaceRoot }).workspace_agents,
  },
): boolean {
  if (configurationTarget(roots, path) === undefined) return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
