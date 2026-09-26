#!/usr/bin/env bun
/** Verify the native portable archive, fast paths, and real-PTY complete-app boot. */
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  releaseAssetName,
  releaseRuntimeExecutableName,
  releaseTarget,
} from "../../src/update-contract.ts";
import {
  containsInlineSourceMap,
  isReleaseSourceMapPath,
  parseReleaseManifest,
  restoreReleaseModes,
  verifyReleaseTree,
} from "../../src/update/release-manifest.ts";
import { createSmokeFixture } from "../artifact/isolation.ts";
import { bootAndObserve, readable } from "../artifact/pty.ts";
import { APP_READY_MARKER } from "../artifact/markers.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");

async function commandOutput(
  command: string[],
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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

async function qualifyNativeArchive(
  archive: Bun.Archive,
  environment: Record<string, string>,
  manifest: ReturnType<typeof parseReleaseManifest>,
): Promise<string> {
  const nativeRoot = await mkdtemp(join(repositoryRoot, "build", "release", ".native-smoke-"));
  try {
    await archive.extract(nativeRoot);
    const productRoot = join(nativeRoot, "clarvis");
    await verifyReleaseTree(productRoot, manifest);
    await restoreReleaseModes(productRoot, manifest);
    const runtime = join(productRoot, "runtime", releaseRuntimeExecutableName());
    const canary = join(
      productRoot,
      "packages",
      "kernel",
      "tests",
      "fixtures",
      "release-native-canary.ts",
    );
    await mkdir(dirname(canary), { recursive: true });
    await copyFile(
      join(repositoryRoot, "packages", "kernel", "tests", "fixtures", "release-native-canary.ts"),
      canary,
    );
    await chmod(runtime, 0o755);
    const result = await commandOutput([runtime, canary, productRoot], environment);
    if (result.code !== 0 || !result.stdout.includes("native release sandbox ok -")) {
      throw new Error(
        `portable native sandbox failed: ${result.stderr.slice(-2000)} ${result.stdout.slice(-1000)}`,
      );
    }
    return result.stdout.trim();
  } finally {
    await rm(nativeRoot, { recursive: true, force: true });
  }
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
  const fixture = await createSmokeFixture("clarvis-release-smoke-");
  const temporary = fixture.root;
  const installRoot = fixture.install;
  const versionRoot = join(installRoot, "versions", `v${product.version}`);
  try {
    const environment = fixture.environmentFor({ CLARVIS_INSTALL_ROOT: installRoot });
    const smokePaths = fixture.paths;
    await mkdir(smokePaths.state, { recursive: true });
    await writeFile(
      smokePaths.codeConfigFile,
      JSON.stringify({ updateCheck: { enabled: false } }, null, 2) + "\n",
      { mode: 0o600 },
    );
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
    await restoreReleaseModes(versionRoot, manifest);
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
    const runtimeName = releaseRuntimeExecutableName();
    const runtime = join(versionRoot, "runtime", runtimeName);
    const legacyRuntime = join(versionRoot, "runtime", "bun");
    await chmod(runtime, 0o755);
    const entry = join(versionRoot, "packages", "code", "src", "cli.ts");
    const identity = await commandOutput(
      [runtime, "-e", "process.stdout.write(process.execPath)"],
      environment,
    );
    if (
      identity.code !== 0 ||
      identity.stderr !== "" ||
      basename(identity.stdout) !== runtimeName
    ) {
      throw new Error("portable runtime did not retain the Clarvis executable identity");
    }
    if (process.platform === "linux") {
      const comm = await commandOutput(
        [runtime, "-e", 'process.stdout.write((await Bun.file("/proc/self/comm").text()).trim())'],
        environment,
      );
      if (comm.code !== 0 || comm.stderr !== "" || comm.stdout !== "clarvis") {
        throw new Error("portable runtime was not exposed as clarvis by the Linux process table");
      }
    }
    for (const [flag, expected] of [
      ["--version", `clarvis ${product.version}\n`],
      ["--help", "--update"],
    ] as const) {
      const result = await commandOutput([runtime, entry, flag], environment);
      if (result.code !== 0 || result.stderr !== "" || !result.stdout.includes(expected)) {
        throw new Error(`portable ${flag} smoke failed with exit ${String(result.code)}`);
      }
    }
    const legacy = await commandOutput([legacyRuntime, entry, "--version"], environment);
    if (
      legacy.code !== 0 ||
      legacy.stderr !== "" ||
      legacy.stdout !== `clarvis ${product.version}\n`
    ) {
      throw new Error("portable runtime lost compatibility with an older launcher");
    }
    const boot = await bootAndObserve({
      runtime,
      entry,
      args: ["--debug"],
      context: fixture,
      markers: [{ name: "ready", text: APP_READY_MARKER }],
      timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000),
      pollMs: 100,
      overrides: { CLARVIS_INSTALL_ROOT: installRoot },
    });
    if (boot.outcome !== "ready") {
      throw new Error(
        `portable complete-app boot ${boot.outcome}\n${readable(boot.screen).slice(-3000)}\n${boot.stderr.slice(-1000)}`,
      );
    }
    const native = await qualifyNativeArchive(archive, environment, manifest);
    process.stdout.write(
      `release smoke ok - ${target} ${product.version} observed the complete-app marker after ${boot.elapsed.toFixed(0)}ms of outer PTY/polling time; ${native}\n`,
    );
  } finally {
    await fixture.cleanup();
  }
}

await main();
