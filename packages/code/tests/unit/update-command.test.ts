import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  releaseRuntimeExecutableName,
  releaseTarget,
  type ReleaseTarget,
} from "../../src/update-contract.ts";
import type { ReleaseFetch } from "../../src/update/github-releases.ts";
import { runUpdateCommand } from "../../src/update/index.ts";
import {
  activateStagedRelease,
  extractReleaseArchive,
  managedInstallation,
  verifyStagedRelease,
  withUpdateLock,
} from "../../src/update/installation.ts";
import { manifestFiles } from "../../src/update/release-manifest.ts";

function output(): { stream: { write(value: string): boolean }; text: () => string } {
  let value = "";
  return {
    stream: {
      write(chunk: string): boolean {
        value += chunk;
        return true;
      },
    },
    text: () => value,
  };
}

async function stagedRelease(
  root: string,
  version: string,
  target: ReleaseTarget,
  command: string,
): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "packages", "code", "src"), { recursive: true });
  await writeFile(join(root, "runtime", releaseRuntimeExecutableName()), `#!/bin/sh\n${command}\n`);
  await writeFile(join(root, "packages", "code", "src", "cli.ts"), "");
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schema: 1,
      repository: "getclarvis/clarvis-releases",
      version,
      target,
      files: await manifestFiles(root),
    }),
  );
}

test("source and unmanaged invocations refuse update before any network request", async () => {
  let fetched = false;
  const fetcher: ReleaseFetch = () => {
    fetched = true;
    return Promise.resolve(new Response("[]"));
  };
  for (const environment of [{ CLARVIS_CODE_SOURCE: "1" }, {}]) {
    const stderr = output();
    expect(
      await runUpdateCommand({
        currentVersion: "0.0.1-beta",
        environment,
        fetch: fetcher,
        stderr: stderr.stream,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("update failed");
  }
  expect(fetched).toBe(false);
});

test("a managed installation with no eligible release is a clean no-op", async () => {
  const target = releaseTarget();
  if (target === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-"));
  const versionRoot = join(root, "versions", "v0.0.1-beta");
  await mkdir(versionRoot, { recursive: true });
  await writeFile(join(root, "current"), "v0.0.1-beta\n");
  await writeFile(
    join(versionRoot, "release.json"),
    JSON.stringify({
      schema: 1,
      repository: "getclarvis/clarvis-releases",
      version: "0.0.1-beta",
      target,
      files: [{ path: "placeholder", size: 0, sha256: "a".repeat(64) }],
    }),
  );
  const stdout = output();
  try {
    expect(
      await runUpdateCommand({
        currentVersion: "0.0.1-beta",
        environment: { CLARVIS_INSTALL_ROOT: root },
        fetch: () => Promise.resolve(new Response("[]")),
        stdout: stdout.stream,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("already up to date");
    await expect(readFile(join(root, "update.lock"), "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed installation rejects an active version changed by another process", async () => {
  const target = releaseTarget();
  if (target === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-drift-"));
  await writeFile(join(root, "current"), "v0.0.2-beta\n");
  try {
    await expect(
      managedInstallation({ CLARVIS_INSTALL_ROOT: root }, "0.0.1-beta", target),
    ).rejects.toThrow("active installation changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing updater lock refuses a second mutation and remains owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-lock-"));
  const lock = join(root, "update.lock");
  await writeFile(lock, "123 prior-owner\n");
  try {
    await expect(withUpdateLock(root, () => Promise.resolve())).rejects.toThrow(
      "another Clarvis update is active",
    );
    expect(await readFile(lock, "utf8")).toBe("123 prior-owner\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unexpected updater-lock filesystem failure is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-lock-error-"));
  try {
    await expect(
      withUpdateLock(join(root, "missing"), () => Promise.resolve()),
    ).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archive with the wrong top-level payload is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-archive-"));
  const archive = join(root, "invalid.tar.gz");
  const stage = join(root, "stage");
  await mkdir(stage);
  await Bun.Archive.write(
    archive,
    { "other/file.txt": new TextEncoder().encode("invalid") },
    {
      compress: "gzip",
    },
  );
  try {
    await expect(extractReleaseArchive(archive, stage)).rejects.toThrow(
      "must contain only the clarvis payload",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged runtime verification bounds output and rejects the wrong version", async () => {
  if (process.platform === "win32") return;
  const target = releaseTarget();
  if (target === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-smoke-failures-"));
  try {
    const oversized = join(root, "oversized");
    await stagedRelease(oversized, "0.0.2-beta", target, `printf '${"x".repeat(9_000)}'`);
    await expect(
      verifyStagedRelease(oversized, {
        version: "0.0.2-beta",
        target,
        installRoot: root,
      }),
    ).rejects.toThrow("output exceeded its bound");

    const wrong = join(root, "wrong");
    await stagedRelease(wrong, "0.0.2-beta", target, "printf 'clarvis wrong\\n'");
    await expect(
      verifyStagedRelease(wrong, {
        version: "0.0.2-beta",
        target,
        installRoot: root,
      }),
    ).rejects.toThrow("version smoke failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation verifies an existing version and rejects a non-directory destination", async () => {
  if (process.platform === "win32") return;
  const target = releaseTarget();
  if (target === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-existing-"));
  const versions = join(root, "versions");
  await mkdir(versions);
  const installation = { root, versions, currentTag: "v0.0.1-beta" };
  try {
    const existing = join(versions, "v0.0.2-beta");
    await stagedRelease(existing, "0.0.2-beta", target, "printf 'clarvis 0.0.2-beta\\n'");
    await activateStagedRelease(installation, join(root, "unused-stage"), "0.0.2-beta", target);
    expect(await readFile(join(root, "current"), "utf8")).toBe("v0.0.2-beta\n");

    await writeFile(join(versions, "v0.0.3-beta"), "not a directory");
    await expect(
      activateStagedRelease(installation, join(root, "unused-stage"), "0.0.3-beta", target),
    ).rejects.toThrow("release destination is not a directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an eligible verified archive is staged, smoked and activated last", async () => {
  if (process.platform === "win32") return;
  const target = releaseTarget();
  if (target === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clarvis-managed-update-activate-"));
  const oldRoot = join(root, "versions", "v0.0.1-beta");
  const buildRoot = join(root, "build");
  const archivePath = join(root, "update.tar.gz");
  await mkdir(oldRoot, { recursive: true });
  await mkdir(join(buildRoot, "runtime"), { recursive: true });
  await mkdir(join(buildRoot, "packages", "code", "src"), { recursive: true });
  await writeFile(join(root, "current"), "v0.0.1-beta\n");
  await writeFile(
    join(oldRoot, "release.json"),
    JSON.stringify({
      schema: 1,
      repository: "getclarvis/clarvis-releases",
      version: "0.0.1-beta",
      target,
      files: [{ path: "placeholder", size: 0, sha256: "a".repeat(64) }],
    }),
  );
  await writeFile(
    join(buildRoot, "runtime", "clarvis"),
    "#!/bin/sh\nprintf 'clarvis 0.0.2-beta\\n'\n",
  );
  await writeFile(join(buildRoot, "packages", "code", "src", "cli.ts"), "");
  const manifest = {
    schema: 1,
    repository: "getclarvis/clarvis-releases",
    version: "0.0.2-beta",
    target,
    files: await manifestFiles(buildRoot),
  };
  await writeFile(join(buildRoot, "release.json"), JSON.stringify(manifest));
  const entries: Record<string, Uint8Array> = {};
  for (const file of manifest.files) {
    entries[`clarvis/${file.path}`] = await Bun.file(join(buildRoot, file.path)).bytes();
  }
  entries["clarvis/release.json"] = await Bun.file(join(buildRoot, "release.json")).bytes();
  await Bun.Archive.write(archivePath, entries, { compress: "gzip" });
  const archive = await Bun.file(archivePath).bytes();
  const digest = createHash("sha256").update(archive).digest("hex");
  const assetName = `clarvis-v0.0.2-beta-${target}.tar.gz`;
  const assetUrl = `https://github.com/getclarvis/clarvis-releases/releases/download/v0.0.2-beta/${assetName}`;
  let calls = 0;
  const fetcher: ReleaseFetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        Response.json([
          {
            tag_name: "v0.0.2-beta",
            draft: false,
            prerelease: true,
            published_at: "2026-08-25T00:00:00Z",
            assets: [
              {
                name: assetName,
                size: archive.byteLength,
                digest: `sha256:${digest}`,
                state: "uploaded",
                browser_download_url: assetUrl,
              },
            ],
          },
        ]),
      );
    }
    return Promise.resolve(
      new Response(archive, { headers: { "content-length": String(archive.byteLength) } }),
    );
  };
  const stdout = output();
  const stderr = output();
  try {
    expect(
      await runUpdateCommand({
        currentVersion: "0.0.1-beta",
        environment: { CLARVIS_INSTALL_ROOT: root },
        fetch: fetcher,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("0.0.1-beta -> 0.0.2-beta");
    expect(await readFile(join(root, "current"), "utf8")).toBe("v0.0.2-beta\n");
    expect((await stat(oldRoot)).isDirectory()).toBe(true);
    expect((await stat(join(root, "versions", "v0.0.2-beta"))).isDirectory()).toBe(true);
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
