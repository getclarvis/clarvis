import { describe, expect, it } from "bun:test";
import {
  classifyNativeCanary,
  containerCanaryRequested,
  inspectContainerCanary,
  requireContainerCanary,
} from "../helpers/native-canary.ts";

const digest = `sha256:${"a".repeat(64)}`;

describe("container canary admission", () => {
  it("keeps an absent opt-in distinct from a passing canary", () => {
    expect(containerCanaryRequested({})).toBe(false);
    expect(inspectContainerCanary({}, () => "/bin/engine")).toEqual({
      status: "skipped",
      reason: "no container canary gate is enabled",
    });
  });

  it("fails a requested canary closed on malformed inputs", () => {
    const environment = {
      CLARVIS_DOCKER_RUNTIME_CANARY: "1",
      CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST: "clarvis-runtime:latest",
      CLARVIS_DOCKER_RUNTIME_CONTEXT: "fixture",
    };
    expect(inspectContainerCanary(environment, () => "/bin/docker")).toMatchObject({
      status: "misconfigured",
      engine: "docker",
    });
    expect(() => requireContainerCanary(environment, () => "/bin/docker")).toThrow(
      "[misconfigured]",
    );
  });

  it("reports a missing selected engine as unavailable", () => {
    expect(
      inspectContainerCanary(
        {
          CLARVIS_PODMAN_RUNTIME_CANARY: "1",
          CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST: digest,
          CLARVIS_PODMAN_RUNTIME_CONNECTION: "fixture",
        },
        () => null,
      ),
    ).toMatchObject({ status: "unavailable", engine: "podman" });
  });

  it("admits Docker and Podman separately with canonical identities", () => {
    expect(
      inspectContainerCanary(
        {
          CLARVIS_DOCKER_RUNTIME_CANARY: "1",
          CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST: digest,
          CLARVIS_DOCKER_RUNTIME_CONTEXT: "desktop-linux",
        },
        (engine) => `/bin/${engine}`,
      ),
    ).toEqual({
      status: "available",
      engine: "docker",
      executable: "/bin/docker",
      imageDigest: digest,
      context: "desktop-linux",
    });
    expect(
      inspectContainerCanary(
        {
          CLARVIS_PODMAN_RUNTIME_CANARY: "1",
          CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST: digest,
          CLARVIS_PODMAN_RUNTIME_CONNECTION: "rootless",
        },
        (engine) => `/bin/${engine}`,
      ),
    ).toMatchObject({ status: "available", engine: "podman", context: "rootless" });
  });

  it("rejects an ambiguous dual-engine gate", () => {
    expect(
      inspectContainerCanary(
        {
          CLARVIS_DOCKER_RUNTIME_CANARY: "1",
          CLARVIS_PODMAN_RUNTIME_CANARY: "1",
        },
        () => "/bin/engine",
      ),
    ).toMatchObject({ status: "misconfigured" });
  });
});

describe("native canary verdicts", () => {
  it("does not confuse listener denial with a port collision", () => {
    expect(classifyNativeCanary({ boundary: "listener", code: "EACCES" })).toEqual({
      status: "unavailable",
      reason: "listener denied by environment policy",
    });
    expect(classifyNativeCanary({ boundary: "listener", code: "EADDRINUSE" })).toEqual({
      status: "failed",
      reason: "listener bind failed",
    });
  });

  it("does not confuse a missing executable with policy denial", () => {
    expect(classifyNativeCanary({ boundary: "executable", code: "ENOENT" }).reason).toBe(
      "executable is missing",
    );
    expect(classifyNativeCanary({ boundary: "executable", code: "EPERM" }).reason).toBe(
      "executable denied by environment policy",
    );
  });

  it("does not confuse an unavailable engine with a failed admitted container", () => {
    expect(
      classifyNativeCanary({ boundary: "engine", phase: "probe", available: false }).status,
    ).toBe("unavailable");
    expect(classifyNativeCanary({ boundary: "engine", phase: "start" }).status).toBe("failed");
  });

  it("accepts expected network denial but rejects accidental download denial", () => {
    expect(
      classifyNativeCanary({ boundary: "network", denied: true, denialExpected: true }).status,
    ).toBe("executed");
    expect(
      classifyNativeCanary({ boundary: "network", denied: true, denialExpected: false }).status,
    ).toBe("failed");
  });

  it("does not report a skipped prerequisite as pass", () => {
    expect(classifyNativeCanary({ boundary: "precondition", satisfied: false })).toMatchObject({
      status: "skipped",
    });
  });
});
