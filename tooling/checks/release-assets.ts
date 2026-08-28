#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_REPOSITORY, type ReleaseTarget } from "../../packages/code/src/update-contract.ts";
import {
  containsInlineSourceMap,
  isReleaseSourceMapPath,
} from "../../packages/code/src/update/release-manifest.ts";

export const RELEASE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
] as const satisfies readonly ReleaseTarget[];

const STATIC_RELEASE_ASSETS = [
  "BUN-LICENSE.md",
  "LICENSE",
  "MODELS-DEV-LICENSE",
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.md",
  "VERCEL-AI-SDK-LICENSE",
  "install.ps1",
  "install.sh",
] as const;

const RELEASE_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");
}

async function archiveFailures(
  archivePath: string,
  version: string,
  target: ReleaseTarget,
): Promise<string[]> {
  const failures: string[] = [];
  const temporary = await mkdtemp(join(tmpdir(), "clarvis-release-assets-"));
  try {
    const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
    await archive.extract(temporary);
    const topLevel = await readdir(temporary);
    if (topLevel.length !== 1 || topLevel[0] !== "clarvis") {
      return [`${archivePath} must contain only the clarvis payload`];
    }
    const payload = join(temporary, "clarvis");
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
        else if (!entry.isFile()) failures.push(`${archivePath} contains non-regular ${relative}`);
        else if (isReleaseSourceMapPath(relative)) {
          failures.push(`${archivePath} contains source map ${relative}`);
        } else if (
          /\.(?:[cm]?[jt]sx?|css)$/i.test(entry.name) &&
          containsInlineSourceMap(await readFile(join(directory, entry.name), "utf8"))
        ) {
          failures.push(`${archivePath} contains inline source map ${relative}`);
        }
      }
    };
    await visit(payload, "");
    const manifest = JSON.parse(await readFile(join(payload, "release.json"), "utf8")) as {
      repository?: unknown;
      version?: unknown;
      target?: unknown;
    };
    if (
      manifest.repository !== RELEASE_REPOSITORY ||
      manifest.version !== version ||
      manifest.target !== target
    ) {
      failures.push(`${archivePath} has a mismatched release manifest identity`);
    }
  } catch (error) {
    failures.push(
      `${archivePath} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return failures;
}

/** Verify the complete allowlisted cross-platform asset set before any GitHub Release is created. */
export async function releaseAssetSetFailures(directory: string, tag: string): Promise<string[]> {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) return [`release asset verification requires an exact v<SemVer> tag: ${tag}`];
  const version = tag.slice(1);
  const archiveNames = RELEASE_TARGETS.map((target) => `clarvis-v${version}-${target}.tar.gz`);
  const expected = new Set([
    ...archiveNames,
    ...archiveNames.map((name) => `${name}.sha256`),
    ...STATIC_RELEASE_ASSETS,
  ]);
  const failures: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = new Set<string>();
  for (const entry of entries) {
    actual.add(entry.name);
    if (!entry.isFile()) failures.push(`release set contains non-file entry ${entry.name}`);
    if (!expected.has(entry.name))
      failures.push(`release set contains unexpected asset ${entry.name}`);
  }
  for (const name of expected) {
    if (!actual.has(name)) failures.push(`release set is missing ${name}`);
  }

  const checksumEntries: { name: string; line: string }[] = [];
  for (let index = 0; index < RELEASE_TARGETS.length; index += 1) {
    const target = RELEASE_TARGETS[index];
    const name = archiveNames[index];
    if (target === undefined || name === undefined || !actual.has(name)) continue;
    const archivePath = join(directory, name);
    const sha256 = await digest(archivePath);
    const line = `${sha256}  ${name}\n`;
    checksumEntries.push({ name, line });
    const sidecarName = `${name}.sha256`;
    if (
      actual.has(sidecarName) &&
      (await readFile(join(directory, sidecarName), "utf8")) !== line
    ) {
      failures.push(`${sidecarName} does not match ${name}`);
    }
    failures.push(...(await archiveFailures(archivePath, version, target)));
  }

  if (actual.has("SHA256SUMS")) {
    const aggregate = checksumEntries
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(({ line }) => line)
      .join("");
    if ((await readFile(join(directory, "SHA256SUMS"), "utf8")) !== aggregate) {
      failures.push("SHA256SUMS does not match the six verified archives");
    }
  }
  for (const name of STATIC_RELEASE_ASSETS) {
    if (actual.has(name) && Bun.file(join(directory, name)).size === 0) {
      failures.push(`release asset ${name} must not be empty`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const [directory, tag] = process.argv.slice(2);
  if (directory === undefined || tag === undefined) {
    throw new Error("usage: release-assets.ts <release-directory> <vSemVer-tag>");
  }
  const failures = await releaseAssetSetFailures(directory, tag);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`release assets: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `release assets: verified ${String(RELEASE_TARGETS.length)} map-free archives for ${tag}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
