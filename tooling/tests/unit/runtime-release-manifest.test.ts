import { describe, expect, test } from "bun:test";

import {
  RUNTIME_ARTIFACT_REPOSITORY,
  RUNTIME_BASE_IMAGE,
  RUNTIME_BUILD_IMAGE,
  RUNTIME_IMAGE_REPOSITORY,
  RUNTIME_PROTOCOL_REVISION,
} from "../../runtime/build-image.ts";
import {
  createRuntimeReleaseManifest,
  parseRuntimeReleaseManifest,
  RUNTIME_RELEASE_PLATFORMS,
  RUNTIME_SOURCE_REPOSITORY,
} from "../../runtime/release-manifest.ts";

const input = {
  version: "0.1.1",
  sourceRevision: "a".repeat(40),
  artifactImage: `${RUNTIME_ARTIFACT_REPOSITORY}@sha256:${"b".repeat(64)}`,
  runtimeImage: `${RUNTIME_IMAGE_REPOSITORY}@sha256:${"c".repeat(64)}`,
};

describe("runtime release manifest", () => {
  test("binds one product version and protocol to immutable multi-platform images", () => {
    const manifest = createRuntimeReleaseManifest(input);
    expect(manifest).toEqual({
      schema: 1,
      repository: RUNTIME_SOURCE_REPOSITORY,
      version: input.version,
      source_revision: input.sourceRevision,
      protocol_revision: RUNTIME_PROTOCOL_REVISION,
      platforms: RUNTIME_RELEASE_PLATFORMS,
      artifact_image: input.artifactImage,
      runtime_image: input.runtimeImage,
      build_image: RUNTIME_BUILD_IMAGE,
      base_image: RUNTIME_BASE_IMAGE,
    });
    expect(parseRuntimeReleaseManifest(`${JSON.stringify(manifest)}\n`, input.version)).toEqual(
      manifest,
    );
  });

  test("rejects mutable, foreign, malformed, or cross-version identities", () => {
    expect(() =>
      createRuntimeReleaseManifest({ ...input, runtimeImage: "runtime:latest" }),
    ).toThrow(RUNTIME_IMAGE_REPOSITORY);
    expect(() =>
      createRuntimeReleaseManifest({
        ...input,
        artifactImage: `ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      }),
    ).toThrow(RUNTIME_ARTIFACT_REPOSITORY);
    expect(() => createRuntimeReleaseManifest({ ...input, sourceRevision: "short" })).toThrow(
      "complete lowercase Git commit",
    );
    expect(() =>
      parseRuntimeReleaseManifest(JSON.stringify(createRuntimeReleaseManifest(input)), "0.1.2"),
    ).toThrow("does not match the release");
  });

  test("rejects unknown fields and drift in protocol, toolchain, or platforms", () => {
    const manifest = createRuntimeReleaseManifest(input);
    expect(() =>
      parseRuntimeReleaseManifest(JSON.stringify({ ...manifest, unexpected: true })),
    ).toThrow("unexpected field set");
    expect(() =>
      parseRuntimeReleaseManifest(JSON.stringify({ ...manifest, protocol_revision: "999" })),
    ).toThrow("identity does not match");
    expect(() =>
      parseRuntimeReleaseManifest(JSON.stringify({ ...manifest, build_image: "oven/bun:latest" })),
    ).toThrow("identity does not match");
    expect(() =>
      parseRuntimeReleaseManifest(JSON.stringify({ ...manifest, platforms: ["linux/amd64"] })),
    ).toThrow("unsupported platform set");
  });
});
