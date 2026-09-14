import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  containerArtifactVolumeName,
  containerDataVolumeNames,
  containerGuestPaths,
  containerKernelStatePaths,
  containerLaunchPaths,
  globalPaths,
} from "../../src/index.ts";

const namespace = "a".repeat(64);

describe("Container paths and names", () => {
  test("launch coordination lives outside workspace namespaces and exposes no endpoint", () => {
    const root = resolve("operator state, espaço");
    const paths = containerLaunchPaths(namespace, root);
    expect(paths).toEqual({
      root: join(root, "state", "container-hosts", namespace),
      leaseFile: join(root, "state", "container-hosts", namespace, "launch.lock"),
      registryFile: join(root, "state", "container-hosts", namespace, "registry.json"),
    });
    expect(containerLaunchPaths(namespace).root).toBe(
      join(globalPaths().state, "container-hosts", namespace),
    );
  });

  test("data roles are stable, separate and independent of product artifact", () => {
    expect(containerDataVolumeNames(namespace)).toEqual({
      content: `clarvis-data-v1-${namespace}-content`,
      state: `clarvis-data-v1-${namespace}-state`,
    });
    expect(containerArtifactVolumeName(namespace)).toBe(`clarvis-artifact-v1-${namespace}`);
    expect(containerDataVolumeNames("b".repeat(64))).not.toEqual(
      containerDataVolumeNames(namespace),
    );
  });

  test("guest hosted state uses fixed roots and validates projection components", () => {
    const root = resolve("guest state");
    const paths = containerKernelStatePaths(namespace, root);
    expect(paths.root).toBe(join(root, "state", "container-kernel"));
    expect(paths.registryFile).toBe(join(root, "state", "container-kernel", "runs.json"));
    expect(paths.projectionFile("generation_1", "exec-1")).toBe(
      join(root, "state", "container-kernel", "projections", "generation_1", "exec-1.jsonl"),
    );
    expect(() => paths.projectionFile("../generation", "exec")).toThrow(
      "hosted identity is invalid",
    );
    expect(() => paths.projectionFile("generation", "x".repeat(257))).toThrow(
      "hosted identity is invalid",
    );
    expect(() => containerKernelStatePaths("A".repeat(64), root)).toThrow("full SHA-256");
  });

  test.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `sha256:${namespace}`,
    `../${namespace}`,
    `${namespace}\n`,
    "g".repeat(64),
  ])("refuses noncanonical identity %s", (value) => {
    expect(() => containerLaunchPaths(value)).toThrow("full SHA-256");
    expect(() => containerDataVolumeNames(value)).toThrow("full SHA-256");
    expect(() => containerArtifactVolumeName(value)).toThrow("full SHA-256");
  });

  test("guest paths are fixed Linux paths independent of host separators", () => {
    expect(containerGuestPaths).toEqual({
      workspaceRoot: "/workspace",
      contentRoot: "/workspace/.clarvis",
      agentsMask: "/workspace/.agents",
      globalRoot: "/var/lib/clarvis",
      home: "/var/lib/clarvis/home",
      gitMetadataRoot: "/var/lib/clarvis/git-metadata",
      gitCommonRoot: "/var/lib/clarvis/git-metadata/common",
      artifactRoot: "/opt/clarvis",
      artifactEntrypoint: "/opt/clarvis/bin/clarvis-kernel",
      artifactPayloadSubpath: "payload",
      miseRoot: "/mise",
      tempRoot: "/tmp",
    });
    expect(Object.isFrozen(containerGuestPaths)).toBe(true);
  });
});
