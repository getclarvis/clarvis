import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { agentsWorkspaceDir, workspacePaths } from "@clarvis/paths";

import { RuntimeLaunchError, type RuntimeLaunchSpec } from "./types.ts";
import { CONTAINER_CORE_CAPABILITY_METHODS } from "./container-core-policy.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Validate the complete host-resolved launch authority before engine creation. */
export function assertRuntimeLaunchSpec(spec: RuntimeLaunchSpec): void {
  if (!spec.generation || !spec.ownerId) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime identity is required");
  }
  if (!DIGEST.test(spec.imageDigest)) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime image must use an immutable digest",
    );
  }
  const workspace = resolve(spec.workspaceRoot);
  if (!isAbsolute(spec.workspaceRoot)) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime workspace path must be absolute");
  }
  const protectedMounts = [...spec.controlRootMasks, ...spec.gitMetadataMounts];
  if (
    protectedMounts.some(
      (mount) =>
        !isAbsolute(mount.source) ||
        !isAbsolute(mount.target) ||
        resolve(mount.source) === parse(mount.source).root ||
        mount.readOnly !== true ||
        (mount.type !== "directory" && mount.type !== "file"),
    ) ||
    new Set(protectedMounts.map((mount) => resolve(mount.source))).size !==
      protectedMounts.length ||
    new Set(protectedMounts.map((mount) => mount.target)).size !== protectedMounts.length
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime protected mounts must be unique, absolute, typed and read-only",
    );
  }
  const guestControlTargets = [
    workspacePaths("/workspace").clarvisDir,
    agentsWorkspaceDir("/workspace"),
  ];
  if (
    spec.controlRootMasks.length !== 2 ||
    spec.controlRootMasks.some(
      (mount, index) =>
        mount.target !== guestControlTargets[index] ||
        mount.type !== "directory" ||
        contains(workspace, resolve(mount.source)),
    )
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime control roots must use the two exact private directory masks",
    );
  }
  const dotGitTarget = "/workspace/.git";
  const [dotGit, ...externalGit] = spec.gitMetadataMounts;
  if (
    dotGit === undefined ||
    dotGit.target !== dotGitTarget ||
    (spec.workspace.kind === "external_worktree"
      ? dotGit.type !== "file" ||
        resolve(dotGit.source) !== resolve(workspace, ".git") ||
        externalGit.length < 1 ||
        externalGit.length > 2 ||
        externalGit.some(
          (mount) =>
            mount.type !== "directory" ||
            mount.target !== resolve(mount.source) ||
            contains(workspace, resolve(mount.source)),
        )
      : dotGit.type !== "directory" || externalGit.length !== 0)
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime Git metadata mounts do not match the selected workspace shape",
    );
  }
  const limits = Object.values(spec.limits);
  if (limits.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime limits must be positive integers");
  }
  if (
    spec.capabilityMethods.length !== CONTAINER_CORE_CAPABILITY_METHODS.length ||
    spec.capabilityMethods.some(
      (method, index) => method !== CONTAINER_CORE_CAPABILITY_METHODS[index],
    )
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime capability methods must match the closed Container core policy",
    );
  }
}
