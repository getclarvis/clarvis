import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { isSpillFile } from "@clarvis/paths";
import type { RuntimeConfig } from "../config.ts";
import { analyzeShell } from "../guard/analyze-shell.ts";
import type { ShellDialect } from "../guard/dialect.ts";
import { currentDialect } from "../guard/dialects/index.ts";
import { resolveCandidate } from "../guard/paths.ts";

/**
 * Recognize one persisted, model-readable output artifact owned by this workspace.
 *
 * @param candidate - An already-resolved absolute path.
 * @param stateRoot - The workspace's exact machine-state root.
 * @returns The normalized artifact path, or `undefined` when the candidate is not
 *   a direct, regular, non-link spill in this workspace's local state directory.
 * @remarks This deliberately admits neither the state root nor its local directory.
 * The exact-file result is suitable as an additional confinement root and as a
 * read-only sandbox bind without exposing prompt history, monitor controls, or
 * another workspace's state.
 */
export function readableStateArtifactPath(
  candidate: string,
  stateRoot: string,
): string | undefined {
  if (!isAbsolute(candidate)) return undefined;
  const artifact = normalize(candidate);
  const localDir = resolve(stateRoot, "local");
  if (dirname(artifact) !== localDir || !isSpillFile(basename(artifact))) return undefined;

  try {
    const entry = lstatSync(artifact);
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    const realLocal = realpathSync.native(localDir);
    const realArtifact = realpathSync.native(artifact);
    const rel = relative(realLocal, realArtifact);
    if (rel === "" || isAbsolute(rel) || dirname(rel) !== "." || rel.startsWith("..")) {
      return undefined;
    }
    return artifact;
  } catch {
    return undefined;
  }
}

/**
 * Collect the exact readable state artifacts referenced by one shell command.
 *
 * @param command - The command string that will be guarded or spawned.
 * @param config - Runtime ownership and path configuration.
 * @param dialect - The syntax the command is interpreted as.
 * @returns Deduplicated existing spill paths belonging to this workspace.
 */
function readableStateArtifactsInCommand(
  command: string,
  config: RuntimeConfig,
  dialect: ShellDialect = currentDialect(),
): string[] {
  const artifacts = new Set<string>();
  for (const raw of analyzeShell(command, dialect).paths) {
    const resolved = resolveCandidate(raw, config.workspaceRoot, { shell: true }).resolved;
    const artifact = readableStateArtifactPath(resolved, config.stateRoot);
    if (artifact !== undefined) artifacts.add(artifact);
  }
  return [...artifacts];
}

/** Add exact state artifacts to a sandbox policy as read-only mounts. */
export function sandboxWithReadableStateArtifacts(
  command: string,
  config: RuntimeConfig,
  dialect: ShellDialect = currentDialect(),
): RuntimeConfig["sandbox"] {
  if (config.sandbox === undefined) return undefined;
  const artifacts = readableStateArtifactsInCommand(command, config, dialect);
  if (artifacts.length === 0) return config.sandbox;
  return {
    ...config.sandbox,
    readOnlyPaths: [...(config.sandbox.readOnlyPaths ?? []), ...artifacts],
  };
}
