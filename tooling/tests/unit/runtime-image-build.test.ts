import { describe, expect, it } from "bun:test";
import {
  developmentArtifactImage,
  RUNTIME_ARTIFACT_REPOSITORY,
  RUNTIME_BASE_IMAGE,
  RUNTIME_BUILD_IMAGE,
  RUNTIME_MISE_SHA256_AMD64,
  RUNTIME_MISE_SHA256_ARM64,
  RUNTIME_MISE_VERSION,
  runtimeArtifactBuildArgs,
  runtimeImageBuildArgs,
  runtimeImageBuildPlan,
} from "../../runtime/build-image.ts";

const metadata = {
  version: "0.1.1",
  sourceRevision: "a".repeat(40),
};
const artifact = `${RUNTIME_ARTIFACT_REPOSITORY}@sha256:${"b".repeat(64)}`;

describe("runtime image build command", () => {
  it("builds the runnable image only from the canonical immutable artifact", () => {
    expect(runtimeImageBuildArgs(artifact, "clarvis-runtime:local", metadata)).toEqual([
      "build",
      "--file",
      "Containerfile.runtime",
      "--build-arg",
      `BASE_IMAGE=${RUNTIME_BASE_IMAGE}`,
      "--build-arg",
      `MISE_VERSION=${RUNTIME_MISE_VERSION}`,
      "--build-arg",
      `MISE_SHA256_AMD64=${RUNTIME_MISE_SHA256_AMD64}`,
      "--build-arg",
      `MISE_SHA256_ARM64=${RUNTIME_MISE_SHA256_ARM64}`,
      "--build-arg",
      `RUNTIME_ARTIFACT=${artifact}`,
      "--build-arg",
      "RUNTIME_VERSION=0.1.1",
      "--build-arg",
      `SOURCE_REVISION=${"a".repeat(40)}`,
      "--build-arg",
      "DEVELOPMENT=false",
      "--tag",
      "clarvis-runtime:local",
      ".",
    ]);
  });

  it("builds current source through a separate carrier before the same final image", () => {
    const plan = runtimeImageBuildPlan(["--development", "clarvis-runtime:development"], metadata);
    const carrier = developmentArtifactImage("clarvis-runtime:development");
    expect(plan).toMatchObject({ engine: "docker", mode: "development" });
    expect(plan.commands).toEqual([
      runtimeArtifactBuildArgs(carrier, metadata),
      expect.arrayContaining([
        "--file",
        "Containerfile.runtime",
        `RUNTIME_ARTIFACT=${carrier}`,
        "DEVELOPMENT=true",
      ]),
    ]);
  });

  it("can build only the source carrier for release automation", () => {
    const plan = runtimeImageBuildPlan(
      ["--engine", "podman", "--artifact-only", "clarvis-runtime-artifact:release"],
      metadata,
    );
    expect(plan).toEqual({
      engine: "podman",
      mode: "artifact",
      outputImage: "clarvis-runtime-artifact:release",
      commands: [
        expect.arrayContaining([
          "--file",
          "Containerfile.runtime-development",
          `BUILD_IMAGE=${RUNTIME_BUILD_IMAGE}`,
        ]),
      ],
    });
  });

  it("selects Docker by default and accepts Podman explicitly", () => {
    expect(runtimeImageBuildPlan([artifact, "clarvis-runtime:local"], metadata).engine).toBe(
      "docker",
    );
    expect(
      runtimeImageBuildPlan(["--engine", "podman", artifact, "clarvis-runtime:local"], metadata)
        .engine,
    ).toBe("podman");
    expect(() =>
      runtimeImageBuildPlan(["--engine", "containerd", artifact, "x"], metadata),
    ).toThrow("docker or podman");
  });

  it("refuses mutable or foreign artifacts and malformed metadata", () => {
    expect(() => runtimeImageBuildArgs("clarvis-runtime:latest", "x", metadata)).toThrow(
      RUNTIME_ARTIFACT_REPOSITORY,
    );
    expect(() =>
      runtimeImageBuildArgs(`ghcr.io/example/runtime@sha256:${"b".repeat(64)}`, "x", metadata),
    ).toThrow(RUNTIME_ARTIFACT_REPOSITORY);
    expect(() =>
      runtimeImageBuildArgs(artifact, `clarvis-runtime@sha256:${"c".repeat(64)}`, metadata),
    ).toThrow("explicit local name");
    expect(() =>
      runtimeImageBuildArgs(artifact, "x", { ...metadata, sourceRevision: "short" }),
    ).toThrow("complete lowercase Git commit");
    expect(() =>
      runtimeImageBuildPlan(["--development", "--artifact-only", "x"], metadata),
    ).toThrow("only once");
  });
});
