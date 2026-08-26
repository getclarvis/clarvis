import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isPortableReleasePath,
  manifestFiles,
  parseReleaseManifest,
  verifyReleaseTree,
} from "../../src/update/release-manifest.ts";

test("release paths reject traversal, absolute paths, separators and empty segments", () => {
  expect(isPortableReleasePath("packages/code/src/cli.ts")).toBe(true);
  for (const path of ["", "/etc/passwd", "C:/x", "../x", "a/../b", "a//b", "a\\b"]) {
    expect(isPortableReleasePath(path)).toBe(false);
  }
});

test("manifest generation and verification cover exactly every regular payload file", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-manifest-"));
  try {
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "runtime", "bun"), "runtime");
    await writeFile(join(root, "package.json"), "{}\n");
    const files = await manifestFiles(root);
    const manifest = parseReleaseManifest(
      {
        schema: 1,
        repository: "getclarvis/clarvis",
        version: "0.0.1-beta",
        target: "linux-x64",
        files,
      },
      { version: "0.0.1-beta", target: "linux-x64" },
    );
    await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    await expect(verifyReleaseTree(root, manifest)).resolves.toBeUndefined();
    await writeFile(join(root, "undeclared.txt"), "no");
    await expect(verifyReleaseTree(root, manifest)).rejects.toThrow("file count");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest parsing rejects duplicate, self-referential and malformed file entries", () => {
  const base = {
    schema: 1,
    repository: "getclarvis/clarvis",
    version: "0.0.1-beta",
    target: "linux-x64",
  };
  const file = { path: "runtime/bun", size: 1, sha256: "a".repeat(64) };
  expect(() => parseReleaseManifest({ ...base, files: [file, file] }, base as never)).toThrow(
    "invalid file entry",
  );
  expect(() =>
    parseReleaseManifest({ ...base, files: [{ ...file, path: "release.json" }] }, base as never),
  ).toThrow("invalid file entry");
  expect(() =>
    parseReleaseManifest({ ...base, files: [{ ...file, sha256: "bad" }] }, base as never),
  ).toThrow("invalid file entry");
});
