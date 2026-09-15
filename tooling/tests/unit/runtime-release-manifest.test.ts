import { describe, expect, test } from "bun:test";
import {
  createRuntimeReleaseManifest,
  parseRuntimeReleaseManifest,
  RUNTIME_TARGETS,
} from "../../runtime/release-manifest.ts";

const target = (name: "linux-x64" | "linux-arm64", byte: string) => ({
  base: {
    image: `ghcr.io/getclarvis/clarvis-base-${byte}`,
    digest: `sha256:${byte.repeat(64)}` as const,
    abi: "clarvis-linux-glibc-v1" as const,
  },
  artifact: {
    asset: `clarvis-kernel-${name}.tar.gz`,
    sha256: (byte === "a" ? "c" : "d").repeat(64),
    size: 1024,
  },
  kernel_wire_version: 11 as const,
  broker_version: 1 as const,
  channel_version: 1 as const,
});

const manifest = {
  schema_version: 2 as const,
  version: "1.2.3",
  source_revision: "e".repeat(40),
  targets: {
    "linux-x64": target("linux-x64", "a"),
    "linux-arm64": target("linux-arm64", "b"),
  },
};

describe("runtime release manifest schema 2", () => {
  test("binds both exact Linux targets to independent base and artifact identities", () => {
    expect(RUNTIME_TARGETS).toEqual(["linux-x64", "linux-arm64"]);
    expect(createRuntimeReleaseManifest(manifest)).toEqual(manifest);
    expect(parseRuntimeReleaseManifest(JSON.stringify(manifest), "1.2.3")).toEqual(manifest);
  });

  test("rejects legacy schema, unknown fields, target drift and incompatible protocols", () => {
    for (const value of [
      { ...manifest, schema_version: 1 },
      { ...manifest, extra: true },
      { ...manifest, targets: { "linux-x64": manifest.targets["linux-x64"] } },
      {
        ...manifest,
        targets: {
          ...manifest.targets,
          "linux-x64": { ...manifest.targets["linux-x64"], broker_version: 2 },
        },
      },
      {
        ...manifest,
        targets: {
          ...manifest.targets,
          "linux-x64": {
            ...manifest.targets["linux-x64"],
            artifact: { ...manifest.targets["linux-x64"].artifact, asset: "https://invalid" },
          },
        },
      },
    ])
      expect(() => parseRuntimeReleaseManifest(JSON.stringify(value))).toThrow();
    expect(() => parseRuntimeReleaseManifest(JSON.stringify(manifest), "1.2.4")).toThrow();
  });
});
