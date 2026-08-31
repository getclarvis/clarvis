#!/usr/bin/env bun
/** Build one portable Clarvis archive for the runner's native release target. */
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_REPOSITORY,
  releaseAssetName,
  releaseTarget,
  type ReleaseTarget,
} from "../../src/update-contract.ts";
import {
  containsInlineSourceMap,
  isReleaseSourceMapPath,
  manifestFiles,
} from "../../src/update/release-manifest.ts";
import { assertRuntimePackageRoot, runtimePackageCandidates } from "./runtime-package-discovery.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");
const outputRoot = join(repositoryRoot, "build", "release");

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  dependencies?: unknown;
}

const nativePackages: Record<ReleaseTarget, string> = {
  "darwin-arm64": "@opentui/core-darwin-arm64",
  "darwin-x64": "@opentui/core-darwin-x64",
  "linux-arm64": "@opentui/core-linux-arm64",
  "linux-x64": "@opentui/core-linux-x64",
  "windows-arm64": "@opentui/core-win32-arm64",
  "windows-x64": "@opentui/core-win32-x64",
};

function dependencyNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function packageDirectory(name: string): string {
  return join(repositoryRoot, "node_modules", ...name.split("/"));
}

async function packageManifest(name: string): Promise<PackageManifest> {
  assertRuntimePackageRoot(name);
  const path = join(packageDirectory(name), "package.json");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid dependency manifest: ${path}`);
  }
  return value;
}

async function runtimeClosure(target: ReleaseTarget): Promise<Map<string, PackageManifest>> {
  const pending = [
    "@opentui/core",
    "web-tree-sitter",
    nativePackages[target],
    ...(await discoveredRuntimePackages()),
  ];
  const closure = new Map<string, PackageManifest>();
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || closure.has(name)) continue;
    const manifest = await packageManifest(name);
    if (manifest.name !== name) throw new Error(`dependency identity mismatch for ${name}`);
    closure.set(name, manifest);
    for (const dependency of dependencyNames(manifest.dependencies)) {
      if (!closure.has(dependency)) pending.push(dependency);
    }
  }
  return closure;
}

async function discoveredRuntimePackages(): Promise<string[]> {
  const found = new Set<string>();
  const dist = join(packageRoot, "dist");
  for (const name of await readdir(dist)) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(join(dist, name), "utf8");
    for (const candidate of runtimePackageCandidates(source)) {
      if (
        (await stat(packageDirectory(candidate)).catch(() => undefined))?.isDirectory() === true
      ) {
        found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

async function copySource(payload: string): Promise<void> {
  const files = ["cli.ts", "cli-args.ts", "cli-entry.ts", "update-contract.ts"];
  for (const name of files) {
    const destination = join(payload, "packages", "code", "src", name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packageRoot, "src", name), destination);
  }
  await cp(join(packageRoot, "src", "update"), join(payload, "packages", "code", "src", "update"), {
    recursive: true,
    dereference: true,
  });
  await cp(join(packageRoot, "dist"), join(payload, "packages", "code", "dist"), {
    recursive: true,
    dereference: true,
  });
  await copyFile(join(repositoryRoot, "package.json"), join(payload, "package.json"));
  await copyFile(join(repositoryRoot, "LICENSE"), join(payload, "LICENSE"));
  await copyFile(
    join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    join(payload, "THIRD_PARTY_NOTICES.md"),
  );
  await mkdir(join(payload, "third-party", "bun"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "third-party", "bun", "LICENSE.md"),
    join(payload, "third-party", "bun", "LICENSE.md"),
  );
  await mkdir(join(payload, "third-party", "models.dev"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "third-party", "models.dev", "LICENSE"),
    join(payload, "third-party", "models.dev", "LICENSE"),
  );
  await mkdir(join(payload, "third-party", "vercel-ai-sdk"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "third-party", "vercel-ai-sdk", "LICENSE"),
    join(payload, "third-party", "vercel-ai-sdk", "LICENSE"),
  );
}

async function copyRuntime(payload: string): Promise<void> {
  const runtime = join(payload, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  await mkdir(dirname(runtime), { recursive: true });
  await copyFile(process.execPath, runtime);
  if (process.platform !== "win32") await chmod(runtime, 0o755);
}

async function copyDependencies(
  payload: string,
  closure: ReadonlyMap<string, PackageManifest>,
): Promise<void> {
  const notices: string[] = [
    "Clarvis portable runtime third-party packages:",
    "",
    "See THIRD_PARTY_NOTICES.md for the bundled Bun runtime, models.dev snapshot,",
    "Vercel AI SDK, source and relinking information, and license text locations.",
    "",
  ];
  for (const [name, manifest] of [...closure].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const destination = join(payload, "node_modules", ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(packageDirectory(name), destination, { recursive: true, dereference: true });
    notices.push(
      `${name} ${String(manifest.version ?? "unknown")} — ${String(manifest.license ?? "license in package")}`,
    );
  }
  notices.push("", "The complete license texts remain inside each package directory.", "");
  await writeFile(join(payload, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
}

async function removeSourceMaps(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(path);
    else if (entry.isFile() && isReleaseSourceMapPath(entry.name)) await rm(path);
  }
}

async function assertNoInlineSourceMaps(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoInlineSourceMaps(path);
    else if (
      /\.(?:[cm]?[jt]sx?|css)$/i.test(entry.name) &&
      containsInlineSourceMap(await readFile(path, "utf8"))
    ) {
      throw new Error(`portable releases must not contain inline source maps: ${path}`);
    }
  }
}

async function createArchive(stage: string, archivePath: string): Promise<void> {
  const tar = Bun.which("tar");
  if (tar === null) throw new Error("release packaging requires tar");
  const child = Bun.spawn([tar, "-czf", archivePath, "-C", stage, "clarvis"], {
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error("tar failed to create the release archive");
}

async function main(): Promise<void> {
  const target = releaseTarget();
  if (target === undefined) {
    throw new Error(`unsupported native release target: ${process.platform}/${process.arch}`);
  }
  const product: unknown = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (typeof product !== "object" || product === null || !("version" in product)) {
    throw new Error("root package.json has no product version");
  }
  const version = String(product.version);
  const archiveName = releaseAssetName(version, target);
  await mkdir(outputRoot, { recursive: true });
  const stage = await mkdtemp(join(outputRoot, ".stage-"));
  const payload = join(stage, "clarvis");
  const archivePath = join(outputRoot, archiveName);
  try {
    await mkdir(payload, { recursive: true });
    await copySource(payload);
    await copyRuntime(payload);
    const closure = await runtimeClosure(target);
    await copyDependencies(payload, closure);
    await removeSourceMaps(payload);
    await assertNoInlineSourceMaps(payload);
    const release = {
      schema: 1 as const,
      repository: RELEASE_REPOSITORY,
      version,
      target,
      files: await manifestFiles(payload),
    };
    if (release.files.some((file) => isReleaseSourceMapPath(file.path))) {
      throw new Error("portable releases must not contain source maps");
    }
    await writeFile(join(payload, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
    await rm(archivePath, { force: true });
    await createArchive(stage, archivePath);
    const digest = createHash("sha256")
      .update(await Bun.file(archivePath).bytes())
      .digest("hex");
    await writeFile(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`);
    const bytes = (await stat(archivePath)).size;
    process.stdout.write(
      `release package ${archivePath} (${(bytes / 1024 / 1024).toFixed(1)} MiB, ${String(release.files.length)} files)\n`,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

await main();
