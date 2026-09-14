import { join, posix } from "node:path";
import { AGENTS_DIR, CLARVIS_DIR } from "./constants.ts";
import { globalPaths } from "./global.ts";

/** Host-only process coordination paths; no endpoint, credentials or domain records live here. */
export interface ContainerLaunchPaths {
  readonly root: string;
  readonly leaseFile: string;
  readonly registryFile: string;
}

/** Guest-owned hosted-run state inside the namespace's private state volume. */
export interface ContainerKernelStatePaths {
  readonly root: string;
  readonly registryFile: string;
  projectionFile(generation: string, executionId: string): string;
}

/** Require a full, bare, lowercase SHA-256 identity before using it in a path or engine name. */
function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Container identity must be a full SHA-256 hash");
}

/** Resolve the operator-wide launch lease shared across engines for an admitted namespace. */
export function containerLaunchPaths(namespace: string, globalDir?: string): ContainerLaunchPaths {
  requireHash(namespace);
  const root = join(globalPaths(globalDir).state, "container-hosts", namespace);
  return { root, leaseFile: join(root, "launch.lock"), registryFile: join(root, "registry.json") };
}

/** Resolve native hosted-run machinery without consulting workspace-authored configuration. */
export function containerKernelStatePaths(
  namespace: string,
  globalDir?: string,
): ContainerKernelStatePaths {
  requireHash(namespace);
  const root = join(globalPaths(globalDir).state, "container-kernel");
  const component = (value: string): string => {
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value))
      throw new Error("Container hosted identity is invalid");
    return value;
  };
  return {
    root,
    registryFile: join(root, "runs.json"),
    projectionFile: (generation, executionId) =>
      join(root, "projections", component(generation), `${component(executionId)}.jsonl`),
  };
}

/** Persistent engine volume names. State/content have distinct roles and never include a version. */
export function containerDataVolumeNames(namespace: string): { content: string; state: string } {
  requireHash(namespace);
  return {
    content: `clarvis-data-v1-${namespace}-content`,
    state: `clarvis-data-v1-${namespace}-state`,
  };
}

/** A product artifact has its own immutable volume, independent of every state namespace. */
export function containerArtifactVolumeName(archiveSha256: string): string {
  requireHash(archiveSha256);
  return `clarvis-artifact-v1-${archiveSha256}`;
}

/**
 * Fixed Linux-guest paths, even when the launcher runs on Windows or macOS.
 * Host filesystem paths must never be resolved against this virtual path vocabulary.
 */
export const containerGuestPaths = Object.freeze({
  workspaceRoot: "/workspace" as const,
  contentRoot: posix.join("/workspace", CLARVIS_DIR),
  agentsMask: posix.join("/workspace", AGENTS_DIR),
  globalRoot: "/var/lib/clarvis" as const,
  home: "/var/lib/clarvis/home" as const,
  gitMetadataRoot: "/var/lib/clarvis/git-metadata" as const,
  gitCommonRoot: "/var/lib/clarvis/git-metadata/common" as const,
  artifactRoot: "/opt/clarvis" as const,
  artifactEntrypoint: "/opt/clarvis/bin/clarvis-kernel" as const,
  artifactPayloadSubpath: "payload" as const,
  miseRoot: "/mise" as const,
  tempRoot: "/tmp" as const,
});
