import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CLARVIS_DOCS_FIRST_VERSION,
  CLARVIS_DOCS_PUBLISHER_FILE,
  CLARVIS_DOCS_RELEASE_FILES,
  isPortableReleasePath,
  manifestFiles,
  parseReleaseManifest,
  releaseRequiresClarvisDocs,
  restoreReleaseModes,
  verifyReleaseTree,
} from "../../src/update/release-manifest.ts";

const earlierCandidate = `${CLARVIS_DOCS_FIRST_VERSION}-rc.1`;

test("release paths reject traversal, absolute paths, separators, controls and empty segments", () => {
  expect(isPortableReleasePath("packages/code/src/cli.ts")).toBe(true);
  for (const path of ["", "/etc/passwd", "C:/x", "../x", "a/../b", "a//b", "a\\b", "a\nb"]) {
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
        repository: "getclarvis/clarvis-releases",
        version: earlierCandidate,
        target: "linux-x64",
        files,
      },
      { version: earlierCandidate, target: "linux-x64" },
    );
    await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    await expect(verifyReleaseTree(root, manifest)).resolves.toBeUndefined();
    await writeFile(join(root, "undeclared.txt"), "no");
    await expect(verifyReleaseTree(root, manifest)).rejects.toThrow("file count");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty zero-permission file is verified without reading its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-unreadable-"));
  try {
    const mask = join(root, "mask");
    await writeFile(mask, "");
    await chmod(mask, 0);
    const files = await manifestFiles(root);
    const manifest = parseReleaseManifest(
      {
        schema: 1,
        repository: "getclarvis/clarvis-releases",
        version: earlierCandidate,
        target: "linux-x64",
        files,
      },
      { version: earlierCandidate, target: "linux-x64" },
    );
    await expect(verifyReleaseTree(root, manifest)).resolves.toBeUndefined();
    await chmod(mask, 0o600);
    await writeFile(mask, "changed");
    await expect(verifyReleaseTree(root, manifest)).rejects.toThrow("size mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores native asset permissions after archive extraction loses file modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-modes-"));
  try {
    const mask = join(root, "deny-file");
    const helper = join(root, "launcher");
    await writeFile(mask, "");
    await writeFile(helper, "helper");
    await chmod(mask, 0);
    await chmod(helper, 0o755);
    const manifest = parseReleaseManifest(
      {
        schema: 1,
        repository: "getclarvis/clarvis-releases",
        version: earlierCandidate,
        target: "linux-x64",
        files: await manifestFiles(root),
      },
      { version: earlierCandidate, target: "linux-x64" },
    );
    await chmod(mask, 0o644);
    await chmod(helper, 0o644);
    await verifyReleaseTree(root, manifest);
    await restoreReleaseModes(root, manifest);
    expect((await lstat(mask)).mode & 0o777).toBe(0);
    expect((await lstat(helper)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest parsing rejects duplicate, self-referential and malformed file entries", () => {
  const base = {
    schema: 1,
    repository: "getclarvis/clarvis-releases",
    version: earlierCandidate,
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
  expect(() =>
    parseReleaseManifest({ ...base, files: [{ ...file, mode: 0o4755 }] }, base as never),
  ).toThrow("invalid file entry");
  expect(() =>
    parseReleaseManifest(
      { ...base, files: [{ ...file, path: "packages/code/dist/debug.MAP" }] },
      base as never,
    ),
  ).toThrow("invalid file entry");
});

test("stable skill-bearing releases require every raw documentation page; older candidates remain valid", () => {
  const base = {
    schema: 1,
    repository: "getclarvis/clarvis-releases",
    target: "linux-x64",
  } as const;
  const ordinary = { path: "runtime/clarvis", size: 1, sha256: "a".repeat(64) };
  const docs = [...CLARVIS_DOCS_RELEASE_FILES, CLARVIS_DOCS_PUBLISHER_FILE].map((path) => ({
    path,
    size: 1,
    sha256: "b".repeat(64),
  }));
  expect(releaseRequiresClarvisDocs(earlierCandidate)).toBe(false);
  expect(releaseRequiresClarvisDocs(CLARVIS_DOCS_FIRST_VERSION)).toBe(true);
  expect(() =>
    parseReleaseManifest(
      { ...base, version: earlierCandidate, files: [ordinary] },
      { version: earlierCandidate, target: "linux-x64" },
    ),
  ).not.toThrow();
  expect(() =>
    parseReleaseManifest(
      { ...base, version: CLARVIS_DOCS_FIRST_VERSION, files: [ordinary, ...docs] },
      { version: CLARVIS_DOCS_FIRST_VERSION, target: "linux-x64" },
    ),
  ).not.toThrow();
  for (const missing of docs) {
    expect(() =>
      parseReleaseManifest(
        {
          ...base,
          version: CLARVIS_DOCS_FIRST_VERSION,
          files: [ordinary, ...docs.filter((item) => item !== missing)],
        },
        { version: CLARVIS_DOCS_FIRST_VERSION, target: "linux-x64" },
      ),
    ).toThrow("missing required Clarvis documentation");
  }
});

test("verified skill-bearing releases reject a modified raw reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-docs-integrity-"));
  try {
    for (const path of [...CLARVIS_DOCS_RELEASE_FILES, CLARVIS_DOCS_PUBLISHER_FILE]) {
      const destination = join(root, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, "a");
    }
    const manifest = parseReleaseManifest(
      {
        schema: 1,
        repository: "getclarvis/clarvis-releases",
        version: CLARVIS_DOCS_FIRST_VERSION,
        target: "linux-x64",
        files: await manifestFiles(root),
      },
      { version: CLARVIS_DOCS_FIRST_VERSION, target: "linux-x64" },
    );
    await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    await expect(verifyReleaseTree(root, manifest)).resolves.toBeUndefined();
    const reference = join(root, ...CLARVIS_DOCS_RELEASE_FILES[1]!.split("/"));
    await writeFile(reference, "b");
    await expect(verifyReleaseTree(root, manifest)).rejects.toThrow("checksum mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation refuses a source map anywhere in the payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-map-manifest-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "debug.map"), "map");
    await expect(manifestFiles(root)).rejects.toThrow("contains a source map");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
