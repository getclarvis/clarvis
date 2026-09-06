import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { RuntimeLaunchError, type RuntimeLaunchSpec } from "./types.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const METHOD = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Validate the complete host-resolved launch authority before engine creation. */
export function assertRuntimeLaunchSpec(spec: RuntimeLaunchSpec): void {
  if (!spec.generation || !spec.ownerId || !spec.configurationRevision || !spec.extensionRevision) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime identity revisions are required");
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
  const readOnlyPaths = spec.readOnlyWorkspacePaths.map((source) => ({
    source,
    resolved: resolve(source),
  }));
  if (
    readOnlyPaths.some(({ source, resolved }) => {
      const fromWorkspace = relative(workspace, resolved);
      return (
        !isAbsolute(source) ||
        fromWorkspace === "" ||
        fromWorkspace === ".." ||
        fromWorkspace.startsWith(`..${sep}`) ||
        isAbsolute(fromWorkspace)
      );
    })
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "read-only runtime paths must be absolute strict descendants of the workspace",
    );
  }
  if (new Set(readOnlyPaths.map(({ resolved }) => resolved)).size !== readOnlyPaths.length) {
    throw new RuntimeLaunchError("invalid_launch_spec", "read-only runtime paths must be unique");
  }
  if (spec.gitCommonDir !== undefined) {
    if (
      !isAbsolute(spec.gitCommonDir) ||
      resolve(spec.gitCommonDir) === parse(spec.gitCommonDir).root
    ) {
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "runtime Git common directory must be an absolute non-root path",
      );
    }
    const common = resolve(spec.gitCommonDir);
    if (contains(common, workspace) || contains(workspace, common)) {
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "runtime Git common directory must be disjoint from the selected workspace",
      );
    }
  }
  const limits = Object.values(spec.limits);
  if (limits.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime limits must be positive integers");
  }
  if (new Set(spec.capabilityMethods).size !== spec.capabilityMethods.length) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "runtime capability methods must be unique",
    );
  }
  if (spec.capabilityMethods.some((method) => !METHOD.test(method))) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime capability method is invalid");
  }
}
