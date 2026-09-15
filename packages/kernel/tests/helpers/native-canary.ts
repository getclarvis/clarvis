export type ContainerCanaryEngine = "docker" | "podman";

export type ContainerCanaryAdmission =
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; engine: ContainerCanaryEngine; reason: string }
  | { status: "misconfigured"; engine: ContainerCanaryEngine; reason: string }
  | {
      status: "available";
      engine: ContainerCanaryEngine;
      executable: string;
      imageDigest: string;
      context: string;
    };

type CanaryEnvironment = Readonly<Record<string, string | undefined>>;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function containerCanaryRequested(environment: CanaryEnvironment): boolean {
  return (
    environment.CLARVIS_DOCKER_RUNTIME_CANARY === "1" ||
    environment.CLARVIS_PODMAN_RUNTIME_CANARY === "1"
  );
}

export function inspectContainerCanary(
  environment: CanaryEnvironment,
  which: (engine: ContainerCanaryEngine) => string | null,
): ContainerCanaryAdmission {
  const dockerRequested = environment.CLARVIS_DOCKER_RUNTIME_CANARY === "1";
  const podmanRequested = environment.CLARVIS_PODMAN_RUNTIME_CANARY === "1";
  if (!dockerRequested && !podmanRequested) {
    return { status: "skipped", reason: "no container canary gate is enabled" };
  }
  if (dockerRequested && podmanRequested) {
    return {
      status: "misconfigured",
      engine: "docker",
      reason: "Docker and Podman canary gates cannot be enabled in the same process",
    };
  }

  const engine: ContainerCanaryEngine = podmanRequested ? "podman" : "docker";
  const imageDigest =
    engine === "podman"
      ? environment.CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST
      : environment.CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST;
  const context =
    engine === "podman"
      ? environment.CLARVIS_PODMAN_RUNTIME_CONNECTION
      : environment.CLARVIS_DOCKER_RUNTIME_CONTEXT;
  if (imageDigest === undefined || !DIGEST.test(imageDigest)) {
    return {
      status: "misconfigured",
      engine,
      reason: `${engine} canary requires a canonical sha256 image digest`,
    };
  }
  if (context === undefined || context.length === 0) {
    return {
      status: "misconfigured",
      engine,
      reason: `${engine} canary requires an explicit context or connection`,
    };
  }
  const executable = which(engine);
  if (executable === null) {
    return {
      status: "unavailable",
      engine,
      reason: `${engine} executable is unavailable`,
    };
  }
  return { status: "available", engine, executable, imageDigest, context };
}

export function requireContainerCanary(
  environment: CanaryEnvironment,
  which: (engine: ContainerCanaryEngine) => string | null,
): Extract<ContainerCanaryAdmission, { status: "available" }> {
  const admission = inspectContainerCanary(environment, which);
  if (admission.status !== "available") {
    throw new Error(`[${admission.status}] ${admission.reason}`);
  }
  return admission;
}

export type NativeCanaryObservation =
  | { boundary: "precondition"; satisfied: boolean }
  | { boundary: "listener"; code: string }
  | { boundary: "executable"; code: string }
  | { boundary: "engine"; phase: "probe" | "start"; available?: boolean }
  | { boundary: "network"; denied: boolean; denialExpected: boolean };

export type NativeCanaryVerdict = {
  status: "executed" | "skipped" | "unavailable" | "failed";
  reason: string;
};

export function classifyNativeCanary(observation: NativeCanaryObservation): NativeCanaryVerdict {
  switch (observation.boundary) {
    case "precondition":
      return observation.satisfied
        ? { status: "executed", reason: "precondition satisfied" }
        : { status: "skipped", reason: "precondition not satisfied" };
    case "listener":
      return observation.code === "EACCES" || observation.code === "EPERM"
        ? { status: "unavailable", reason: "listener denied by environment policy" }
        : { status: "failed", reason: "listener bind failed" };
    case "executable":
      return observation.code === "ENOENT"
        ? { status: "unavailable", reason: "executable is missing" }
        : observation.code === "EACCES" || observation.code === "EPERM"
          ? { status: "unavailable", reason: "executable denied by environment policy" }
          : { status: "failed", reason: "executable spawn failed" };
    case "engine":
      return observation.phase === "probe" && observation.available === false
        ? { status: "unavailable", reason: "container engine is unavailable" }
        : { status: "failed", reason: "container operation failed after admission" };
    case "network":
      return observation.denied && observation.denialExpected
        ? { status: "executed", reason: "network denial observed as required" }
        : { status: "failed", reason: "network behavior did not match the declared boundary" };
  }
}
