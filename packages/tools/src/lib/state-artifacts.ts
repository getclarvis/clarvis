import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { configurationTarget, isSpillFile } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";
import { readFileOptions, type ReadFileOptions } from "./files.ts";
import { resolveFileToolPath } from "./paths.ts";
export interface ReadableStateArtifact {
  readonly path: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint };
}

/**
 * Recognize one persisted, model-readable output artifact owned by this workspace.
 *
 * @param candidate - An already-resolved absolute path.
 * @param stateRoot - The workspace's exact machine-state root.
 * @returns The normalized artifact path, or `undefined` when the candidate is not
 *   a direct, regular, non-link spill in this workspace's local state directory.
 * @remarks This deliberately admits neither the state root nor its local directory.
 * The exact-file result permits a confined read without exposing prompt history, unrelated state, or
 * another workspace's state.
 */
export function readableStateArtifactPath(
  candidate: string,
  stateRoot: string,
): string | undefined {
  if (!isAbsolute(candidate)) return undefined;
  const artifact = normalize(candidate);
  const localDir = resolve(stateRoot, "local");
  if (
    dirname(artifact) !== localDir ||
    !isSpillFile(basename(artifact)) ||
    !/^toolout-[a-f0-9]{8}\.txt$/.test(basename(artifact))
  )
    return undefined;

  try {
    const entry = lstatSync(artifact);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) return undefined;
    if (lstatSync(localDir).isSymbolicLink()) return undefined;
    const realLocal = realpathSync.native(localDir);
    const expectedLocal = resolve(realpathSync.native(stateRoot), "local");
    if (
      (process.platform === "win32" ? realLocal.toLowerCase() : realLocal) !==
      (process.platform === "win32" ? expectedLocal.toLowerCase() : expectedLocal)
    )
      return undefined;
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

/** Pin the exact spill inode admitted by the name and workspace checks. */
function readableStateArtifact(
  candidate: string,
  stateRoot: string,
): ReadableStateArtifact | undefined {
  const path = readableStateArtifactPath(candidate, stateRoot);
  if (path === undefined) return undefined;
  try {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) return undefined;
    return { path, identity: { dev: entry.dev, ino: entry.ino } };
  } catch {
    return undefined;
  }
}

/** Resolve a model read while admitting only one pinned generic spill in state. */
export function resolveReadableTextPath(
  input: string,
  config: RuntimeConfig,
): {
  readonly target: string;
  readonly options: ReadFileOptions;
} {
  const absolute = resolve(config.workspaceRoot, input);
  const stateRelative = relative(config.stateRoot, absolute);
  const inState =
    stateRelative === "" ||
    (!isAbsolute(stateRelative) && stateRelative !== ".." && !stateRelative.startsWith(`..${sep}`));
  const artifact = inState ? readableStateArtifact(absolute, config.stateRoot) : undefined;
  if (inState && artifact === undefined) {
    throw new ToolError("path_escape", `Path is not a readable output artifact: ${input}`, {
      path: input,
    });
  }
  const target =
    artifact === undefined
      ? resolveFileToolPath(input, config)
      : resolveFileToolPath(input, {
          ...config,
          temporaryRoots: [...config.temporaryRoots, artifact.path],
        });
  const admitted =
    config.configurationRoots === undefined
      ? undefined
      : configurationTarget(config.configurationRoots, target);
  const configurationRoot =
    admitted === undefined ? [] : [config.configurationRoots![admitted.root]];
  return {
    target,
    options: {
      ...readFileOptions(config, [
        ...configurationRoot,
        ...(artifact === undefined ? [] : [artifact.path]),
      ]),
      ...(admitted === undefined ? {} : { noFollow: true, requireSingleLink: true }),
      ...(artifact === undefined
        ? {}
        : {
            noFollow: true,
            expectedIdentity: artifact.identity,
            expectedParent: resolve(realpathSync.native(config.stateRoot), "local"),
          }),
    },
  };
}
