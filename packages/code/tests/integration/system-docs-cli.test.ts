import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { productVersion } from "../../src/cli-args.ts";
import { productRootForEntry } from "../../src/cli-entry.ts";
import {
  parseSystemDocsArgs,
  publishSelectedSystemDocs,
} from "../../src/bootstrap/system-docs-cli.ts";
import {
  CLARVIS_DOCS_FIRST_VERSION,
  CLARVIS_DOCS_PUBLISHER_FILE,
  CLARVIS_DOCS_RELEASE_FILES,
  manifestFiles,
} from "../../src/update/release-manifest.ts";

test("standalone publisher accepts one selected root and rejects ambiguous arguments", () => {
  expect(
    parseSystemDocsArgs(["--source-root", "/checkout", "--version", productVersion()]),
  ).toEqual({
    root: "/checkout",
    version: productVersion(),
    kind: "source",
  });
  expect(
    parseSystemDocsArgs([
      "--release-root",
      "/release",
      "--version",
      productVersion(),
      "--target",
      "linux-x64",
      "--global-dir",
      "/alternate",
    ]),
  ).toEqual({
    root: "/release",
    version: productVersion(),
    kind: "release",
    target: "linux-x64",
    globalDir: "/alternate",
  });
  for (const args of [
    [],
    ["--source-root", "/checkout"],
    ["--release-root", "/release", "--version", productVersion()],
    ["--source-root", "/checkout", "--release-root", "/release", "--version", productVersion()],
    ["--source-root", "/checkout", "--version", productVersion(), "--version", productVersion()],
    ["--source-root", "/checkout", "--version", productVersion(), "--unknown", "value"],
    ["--source-root", "/checkout", "--version"],
  ]) {
    expect(() => parseSystemDocsArgs(args)).toThrow();
  }
});

test("source publication uses the selected checkout and an injected Clarvis root", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "clarvis-source-docs-"));
  const root = productRootForEntry(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)));
  try {
    expect(
      await publishSelectedSystemDocs({
        kind: "source",
        root,
        version: productVersion(),
        globalDir: join(fixture, "global"),
      }),
    ).toBe("published");
    expect(
      await readFile(
        join(fixture, "global", "skills", ".system", "clarvis-docs", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: clarvis-docs");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("verified release publication uses only its payload and retires docs on an older release", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "clarvis-release-docs-cli-"));
  const release = join(fixture, "release");
  const globalDir = join(fixture, "global");
  try {
    const asset = fileURLToPath(
      new URL("../../../kernel/assets/skills/.system/clarvis-docs/", import.meta.url),
    );
    await cp(asset, join(release, "packages/kernel/assets/skills/.system/clarvis-docs"), {
      recursive: true,
    });
    const helper = join(release, CLARVIS_DOCS_PUBLISHER_FILE);
    await mkdir(dirname(helper), { recursive: true });
    await writeFile(helper, "verified publisher");
    const manifest = {
      schema: 1,
      repository: "getclarvis/clarvis-releases",
      version: CLARVIS_DOCS_FIRST_VERSION,
      target: "linux-x64",
      files: await manifestFiles(release),
    };
    expect(
      CLARVIS_DOCS_RELEASE_FILES.every((path) => manifest.files.some((f) => f.path === path)),
    ).toBe(true);
    await writeFile(join(release, "release.json"), JSON.stringify(manifest));
    expect(
      await publishSelectedSystemDocs({
        kind: "release",
        root: release,
        version: manifest.version,
        target: "linux-x64",
        globalDir,
      }),
    ).toBe("published");
    expect(await readFile(join(globalDir, "skills/.system/clarvis-docs/SKILL.md"), "utf8")).toBe(
      await readFile(join(asset, "SKILL.md"), "utf8"),
    );

    await rm(release, { recursive: true });
    await mkdir(release);
    await writeFile(join(release, "runtime-marker"), "older release");
    const olderVersion = `${CLARVIS_DOCS_FIRST_VERSION}-rc.1`;
    await writeFile(
      join(release, "release.json"),
      JSON.stringify({
        schema: 1,
        repository: "getclarvis/clarvis-releases",
        version: olderVersion,
        target: "linux-x64",
        files: await manifestFiles(release),
      }),
    );
    expect(
      await publishSelectedSystemDocs({
        kind: "release",
        root: release,
        version: olderVersion,
        target: "linux-x64",
        globalDir,
      }),
    ).toBe("retired");
    await expect(
      readFile(join(globalDir, "skills/.system/clarvis-docs/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
