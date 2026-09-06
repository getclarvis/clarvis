import { ensureWorkspaceSubdir } from "@clarvis/paths";

/**
 * Prepare one host-owned capability directory before container admission.
 *
 * @param directory - Canonical Plans or Memory directory inside the workspace.
 * @param workspaceRoot - Selected workspace that owns the directory.
 * @returns The prepared absolute directory.
 *
 * @remarks This narrow module owns the write so code that resolves shared
 * `.agents` inputs remains structurally read-only.
 */
export function prepareRuntimeCapabilityRoot(directory: string, workspaceRoot: string): string {
  return ensureWorkspaceSubdir(directory, workspaceRoot);
}
