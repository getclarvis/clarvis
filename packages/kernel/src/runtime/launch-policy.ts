import { isAbsolute, relative, resolve } from "node:path";

import { RuntimeLaunchError, type RuntimeLaunchSpec } from "./types.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const METHOD = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

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
  const source = resolve(spec.sourceWorkspaceRoot);
  const retained = resolve(spec.retainedWorkspaceRoot);
  if (!isAbsolute(spec.sourceWorkspaceRoot) || !isAbsolute(spec.retainedWorkspaceRoot)) {
    throw new RuntimeLaunchError("invalid_launch_spec", "runtime workspace paths must be absolute");
  }
  const retainedFromSource = relative(source, retained);
  const sourceFromRetained = relative(retained, source);
  if (
    retained === source ||
    (!retainedFromSource.startsWith("..") && retainedFromSource !== "") ||
    (!sourceFromRetained.startsWith("..") && sourceFromRetained !== "")
  ) {
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "retained runtime workspace must not contain or be contained by the source checkout",
    );
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
