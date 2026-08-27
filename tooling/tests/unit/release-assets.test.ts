import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RELEASE_TARGETS, releaseAssetSetFailures } from "../../checks/release-assets.ts";

const version = "0.0.2-beta";

async function writeArchive(
  directory: string,
  target: (typeof RELEASE_TARGETS)[number],
  sourceMap: false | "file" | "inline" = false,
): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "clarvis-release-assets-fixture-"));
  const payload = join(stage, "clarvis");
  const name = `clarvis-v${version}-${target}.tar.gz`;
  try {
    await mkdir(join(payload, "runtime"), { recursive: true });
    await writeFile(join(payload, "runtime", "bun"), "runtime");
    if (sourceMap === "file") await writeFile(join(payload, "runtime", "debug.MAP"), "map");
    if (sourceMap === "inline") {
      await writeFile(
        join(payload, "runtime", "debug.js"),
        "//# sourceMappingURL=data:application/json;base64,e30=\n",
      );
    }
    await writeFile(
      join(payload, "release.json"),
      `${JSON.stringify({
        schema: 1,
        repository: "getclarvis/clarvis-releases",
        version,
        target,
        files: [],
      })}\n`,
    );
    const tar = Bun.which("tar");
    if (tar === null) throw new Error("test requires tar");
    const child = Bun.spawn([tar, "-czf", join(directory, name), "-C", stage, "clarvis"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await child.exited) !== 0) {
      throw new Error(`fixture tar failed: ${await new Response(child.stderr).text()}`);
    }
    const digest = createHash("sha256")
      .update(await Bun.file(join(directory, name)).bytes())
      .digest("hex");
    await writeFile(join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function writeReleaseSet(directory: string): Promise<void> {
  for (const target of RELEASE_TARGETS) await writeArchive(directory, target);
  for (const name of [
    "BUN-LICENSE.md",
    "LICENSE",
    "MODELS-DEV-LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "VERCEL-AI-SDK-LICENSE",
    "install.ps1",
    "install.sh",
  ]) {
    await writeFile(join(directory, name), `${name}\n`);
  }
  const sidecars = await Promise.all(
    RELEASE_TARGETS.map((target) =>
      readFile(join(directory, `clarvis-v${version}-${target}.tar.gz.sha256`), "utf8"),
    ),
  );
  await writeFile(
    join(directory, "SHA256SUMS"),
    sidecars.sort((left, right) => left.localeCompare(right)).join(""),
  );
}

test("accepts exactly six map-free archives and the allowlisted release assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-assets-test-"));
  try {
    await writeReleaseSet(root);
    await expect(releaseAssetSetFailures(root, `v${version}`)).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a source map inside an archive before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-assets-map-test-"));
  try {
    await writeReleaseSet(root);
    await writeArchive(root, "linux-x64", "file");
    const sidecars = await Promise.all(
      RELEASE_TARGETS.map((target) =>
        readFile(join(root, `clarvis-v${version}-${target}.tar.gz.sha256`), "utf8"),
      ),
    );
    await writeFile(
      join(root, "SHA256SUMS"),
      sidecars.sort((left, right) => left.localeCompare(right)).join(""),
    );
    expect(await releaseAssetSetFailures(root, `v${version}`)).toContainEqual(
      expect.stringContaining("contains source map runtime/debug.MAP"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an inline source map inside an archive before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-assets-inline-map-test-"));
  try {
    await writeReleaseSet(root);
    await writeArchive(root, "linux-x64", "inline");
    const sidecars = await Promise.all(
      RELEASE_TARGETS.map((target) =>
        readFile(join(root, `clarvis-v${version}-${target}.tar.gz.sha256`), "utf8"),
      ),
    );
    await writeFile(
      join(root, "SHA256SUMS"),
      sidecars.sort((left, right) => left.localeCompare(right)).join(""),
    );
    expect(await releaseAssetSetFailures(root, `v${version}`)).toContainEqual(
      expect.stringContaining("contains inline source map runtime/debug.js"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
