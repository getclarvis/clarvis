import { lstatSync } from "node:fs";
import { configurationRoots, configurationTarget } from "@clarvis/paths";

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

/** A recursive replacement may discover authoring leaves below a protected directory.
 * The handler filters leaves before reads and the host reviews the complete prepared batch.
 */
export function isAuthoringSearchScope(path: string, workspaceRoot: string): boolean {
  const roots = configurationRoots({ workspaceRoot });
  if (
    configurationTarget(
      { workspace_clarvis: roots.workspace_clarvis, workspace_agents: roots.workspace_agents },
      path,
    ) === undefined
  )
    return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
