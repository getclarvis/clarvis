import { describe, expect, it } from "bun:test";

import {
  canonicalLocalImageId,
  resolveContainerImageDigest,
} from "../../src/runtime/runtime-image.ts";
import type { ContainerControl } from "../../src/runtime/types.ts";

const hex = "7eae8975314471b0eb8b6ac628bb57d7fa1b85b54662d802bc607ed3f5efd3cd";
const digest = `sha256:${hex}`;

function control(stdout: string, exitCode = 0): ContainerControl {
  return {
    run: async () => ({ exitCode, stdout, stderr: "" }),
    attach: () => {
      throw new Error("attach is outside this test");
    },
  };
}

describe("canonical local runtime image ids", () => {
  it("prefixes a complete Podman local image id and rejects short or tagged identities", () => {
    expect(canonicalLocalImageId(digest)).toBe(digest);
    expect(canonicalLocalImageId(hex)).toBe(digest);
    for (const invalid of [
      undefined,
      "latest",
      hex.slice(0, 12),
      "A".repeat(64),
      `sha512:${hex}`,
    ]) {
      expect(canonicalLocalImageId(invalid)).toBeUndefined();
    }
  });

  it("resolves Docker-prefixed and Podman-unprefixed inspect ids to the same digest", async () => {
    await expect(
      resolveContainerImageDigest({
        configured: undefined,
        control: control(JSON.stringify([{ Id: digest }])),
        engine: "Docker",
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).resolves.toBe(digest);
    await expect(
      resolveContainerImageDigest({
        configured: undefined,
        control: control(JSON.stringify([{ Id: hex }])),
        engine: "Podman",
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).resolves.toBe(digest);
  });

  it("does not treat a Podman manifest digest as the local image id", async () => {
    await expect(
      resolveContainerImageDigest({
        configured: undefined,
        control: control(JSON.stringify([{ Digest: digest }])),
        engine: "Podman",
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).rejects.toThrow("Podman returned an invalid runtime image id");
  });
});
