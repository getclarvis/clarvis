#!/usr/bin/env bun
/** Verify the native portable archive, fast paths, and real-PTY first paint. */
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseAssetName, releaseTarget } from "../../src/update-contract.ts";
import {
  containsInlineSourceMap,
  isReleaseSourceMapPath,
  parseReleaseManifest,
  verifyReleaseTree,
} from "../../src/update/release-manifest.ts";
import { bootAndObserve, makeCleanHome, readable } from "../artifact/pty.ts";
import { APP_READY_MARKER } from "../artifact/markers.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");

async function commandOutput(
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function requireNotice(path: string, markers: readonly string[]): Promise<void> {
  const contents = await readFile(path, "utf8");
  for (const marker of markers) {
    if (!contents.includes(marker)) {
      throw new Error(`portable notice ${path} is missing ${marker}`);
    }
  }
}

async function sourceMaps(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else if (isReleaseSourceMapPath(relative)) found.push(relative);
      else if (
        /\.(?:[cm]?[jt]sx?|css)$/i.test(entry.name) &&
        containsInlineSourceMap(await readFile(join(directory, entry.name), "utf8"))
      ) {
        found.push(`${relative} (inline)`);
      }
    }
  };
  await visit(root, "");
  return found.sort();
}

async function main(): Promise<void> {
  const target = releaseTarget();
  if (target === undefined) throw new Error("native platform is not a release target");
  const product = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const archivePath = join(
    repositoryRoot,
    "build",
    "release",
    releaseAssetName(product.version, target),
  );
  const temporary = await mkdtemp(join(tmpdir(), "clarvis-release-smoke-"));
  const installRoot = join(temporary, "install");
  const versionRoot = join(installRoot, "versions", `v${product.version}`);
  const home = await makeCleanHome();
  const workspace = join(temporary, "workspace");
  try {
    const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
    const extracted = join(temporary, "extracted");
    await archive.extract(extracted);
    await mkdir(join(installRoot, "versions"), { recursive: true });
    await rename(join(extracted, "clarvis"), versionRoot);
    await writeFile(join(installRoot, "current"), `v${product.version}\n`);
    const maps = await sourceMaps(versionRoot);
    if (maps.length > 0) {
      throw new Error(`portable archive contains source maps: ${maps.join(", ")}`);
    }
    const manifest = parseReleaseManifest(
      JSON.parse(await readFile(join(versionRoot, "release.json"), "utf8")),
      { version: product.version, target },
    );
    await verifyReleaseTree(versionRoot, manifest);
    await requireNotice(join(versionRoot, "THIRD_PARTY_NOTICES.md"), [
      "Bun 1.4.0",
      "models.dev snapshot",
      "Vercel AI SDK",
    ]);
    await requireNotice(join(versionRoot, "THIRD_PARTY_NOTICES.txt"), [
      "See THIRD_PARTY_NOTICES.md",
      "Vercel AI SDK",
    ]);
    await requireNotice(join(versionRoot, "third-party", "bun", "LICENSE.md"), [
      "JavaScriptCore",
      "relink Bun with changes",
    ]);
    await requireNotice(join(versionRoot, "third-party", "models.dev", "LICENSE"), [
      "Copyright (c) 2025 models.dev",
    ]);
    await requireNotice(join(versionRoot, "third-party", "vercel-ai-sdk", "LICENSE"), [
      "Copyright 2023 Vercel, Inc.",
      "Apache License, Version 2.0",
    ]);
    const runtime = join(versionRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
    if (process.platform !== "win32") await chmod(runtime, 0o755);
    const entry = join(versionRoot, "packages", "code", "src", "cli.ts");
    for (const [flag, expected] of [
      ["--version", `clarvis ${product.version}\n`],
      ["--help", "--update"],
    ] as const) {
      const result = await commandOutput([runtime, entry, flag]);
      if (result.code !== 0 || result.stderr !== "" || !result.stdout.includes(expected)) {
        throw new Error(`portable ${flag} smoke failed with exit ${String(result.code)}`);
      }
    }
    if (process.platform === "win32") {
      process.stdout.write(
        `release smoke ok - ${target} ${product.version} passed manifest and fast-path checks; PTY first paint is covered by POSIX release jobs\n`,
      );
      return;
    }
    await mkdir(workspace, { recursive: true });
    const boot = await bootAndObserve({
      runtime,
      entry,
      args: ["--debug"],
      home,
      workspace,
      markers: [{ name: "ready", text: APP_READY_MARKER }],
      timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000),
      pollMs: 100,
      extraEnv: { CLARVIS_INSTALL_ROOT: installRoot },
    });
    if (boot.outcome !== "ready") {
      throw new Error(
        `portable first paint ${boot.outcome}\n${readable(boot.screen).slice(-3000)}\n${boot.stderr.slice(-1000)}`,
      );
    }
    process.stdout.write(
      `release smoke ok - ${target} ${product.version} reached first paint in ${boot.elapsed.toFixed(0)}ms\n`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
