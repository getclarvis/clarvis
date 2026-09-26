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
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_REPOSITORY,
  releaseAssetName,
  releaseRuntimeExecutableName,
  releaseTarget,
  type ReleaseTarget,
} from "../../src/update-contract.ts";
import {
  containsInlineSourceMap,
  isReleaseSourceMapPath,
  manifestFiles,
} from "../../src/update/release-manifest.ts";
import { assertRuntimePackageRoot } from "./runtime-package-discovery.ts";

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
};
const sourcePackages = new Set<string>();

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

async function nestedDependencyNames(root: string): Promise<string[]> {
  const found = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "node_modules") {
        const scan = async (packages: string): Promise<void> => {
          for (const child of await readdir(packages, { withFileTypes: true })) {
            if (!child.isDirectory()) continue;
            const childPath = join(packages, child.name);
            if (child.name.startsWith("@")) {
              await scan(childPath);
              continue;
            }
            const manifest = await readFile(join(childPath, "package.json"), "utf8").catch(
              () => undefined,
            );
            if (manifest !== undefined) {
              for (const name of dependencyNames(
                (JSON.parse(manifest) as PackageManifest).dependencies,
              ))
                found.add(name);
            }
            await visit(childPath);
          }
        };
        await scan(path);
      }
    }
  };
  await visit(root);
  return [...found];
}

async function runtimeClosure(target: ReleaseTarget): Promise<Map<string, PackageManifest>> {
  const pending = ["@opentui/core", "web-tree-sitter", "ajv", "diff", nativePackages[target]];
  for (const name of await readdir(join(repositoryRoot, "packages"))) {
    const manifestPath = join(repositoryRoot, "packages", name, "package.json");
    const content = await readFile(manifestPath, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    const manifest = JSON.parse(content) as PackageManifest;
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@clarvis/")) continue;
    sourcePackages.add(manifest.name);
    pending.push(...dependencyNames(manifest.dependencies));
  }
  const closure = new Map<string, PackageManifest>();
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || closure.has(name)) continue;
    if (sourcePackages.has(name)) continue;
    const manifest = await packageManifest(name);
    if (manifest.name !== name) throw new Error(`dependency identity mismatch for ${name}`);
    closure.set(name, manifest);
    for (const dependency of dependencyNames(manifest.dependencies)) {
      if (!closure.has(dependency) && !sourcePackages.has(dependency)) pending.push(dependency);
    }
    for (const dependency of await nestedDependencyNames(packageDirectory(name))) {
      if (!closure.has(dependency) && !sourcePackages.has(dependency)) pending.push(dependency);
    }
  }
  return closure;
}

async function copySource(payload: string): Promise<string | undefined> {
  let denyFile: string | undefined;
  for (const qualified of [...sourcePackages].sort()) {
    const name = qualified.slice("@clarvis/".length);
    const original = join(repositoryRoot, "packages", name);
    const sourceTarget = join(payload, "packages", name);
    await mkdir(sourceTarget, { recursive: true });
    await copyFile(join(original, "package.json"), join(sourceTarget, "package.json"));
    await cp(join(original, "src"), join(sourceTarget, "src"), {
      recursive: true,
      dereference: true,
    });
    if (name === "code") continue;
    const target = join(payload, "node_modules", "@clarvis", name);
    await mkdir(target, { recursive: true });
    await copyFile(join(original, "package.json"), join(target, "package.json"));
    await cp(join(original, "src"), join(target, "src"), {
      recursive: true,
      dereference: true,
    });
    if (name === "sandbox") {
      await cp(join(repositoryRoot, "packages", name, "assets"), join(target, "assets"), {
        recursive: true,
        dereference: true,
        filter: (source) => basename(source) !== "deny-file",
      });
      if (process.platform === "linux") {
        denyFile = join(target, "assets", "native", "deny-file");
        await writeFile(denyFile, "");
        await chmod(denyFile, 0o000);
      }
    }
    if (name === "tools")
      await cp(join(repositoryRoot, "packages", name, "assets"), join(target, "assets"), {
        recursive: true,
        dereference: true,
      });
  }
  await copyFile(join(repositoryRoot, "bun.lock"), join(payload, "bun.lock"));
  const docsDestination = join(
    payload,
    "packages",
    "kernel",
    "assets",
    "skills",
    ".system",
    "clarvis-docs",
  );
  await mkdir(dirname(docsDestination), { recursive: true });
  await cp(
    join(repositoryRoot, "packages", "kernel", "assets", "skills", ".system", "clarvis-docs"),
    docsDestination,
    { recursive: true },
  );
  await copyFile(join(repositoryRoot, "package.json"), join(payload, "package.json"));
  await copyFile(
    join(repositoryRoot, "package.json"),
    join(payload, "node_modules", "package.json"),
  );
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
  if (process.platform === "linux" && denyFile === undefined)
    throw new Error("portable Linux release has no sandbox deny file");
  return denyFile;
}

async function buildSystemDocsPublisher(payload: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(packageRoot, "src", "bootstrap", "system-docs-cli.ts")],
    outdir: join(payload, "runtime"),
    target: "bun",
    sourcemap: "none",
    naming: "system-docs.js",
  });
  if (!result.success) throw new Error("system documentation publisher build failed");
}

async function copyRuntime(payload: string): Promise<void> {
  const runtimeDirectory = join(payload, "runtime");
  const runtime = join(runtimeDirectory, releaseRuntimeExecutableName());
  const legacyRuntime = join(runtimeDirectory, "bun");
  await mkdir(runtimeDirectory, { recursive: true });
  await copyFile(process.execPath, runtime);
  await chmod(runtime, 0o755);
  await writeFile(
    legacyRuntime,
    ["#!/bin/sh", "set -eu", "runtime_dir=${0%/*}", 'exec "$runtime_dir/clarvis" "$@"', ""].join(
      "\n",
    ),
  );
  await chmod(legacyRuntime, 0o755);
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

async function createArchive(
  stage: string,
  archivePath: string,
  denyFile: string | undefined,
): Promise<void> {
  const tar = Bun.which("tar");
  const gzip = Bun.which("gzip");
  if (tar === null || gzip === null) throw new Error("release packaging requires tar and gzip");
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    LC_ALL: "C",
    LANG: "C",
  };
  const rawArchive = join(stage, "payload.tar");
  const sourceMask = join(stage, "deny-mask");
  const archiveDenyFile = denyFile === undefined ? undefined : relative(stage, denyFile);
  await writeFile(sourceMask, "");
  const commands = [
    [
      tar,
      "-cf",
      rawArchive,
      ...(archiveDenyFile === undefined ? [] : [`--exclude=${archiveDenyFile}`]),
      "-C",
      stage,
      "clarvis",
    ],
    ...(archiveDenyFile === undefined
      ? []
      : [
          [
            tar,
            "-rf",
            rawArchive,
            "--mode=000",
            `--transform=s|^deny-mask$|${archiveDenyFile}|`,
            "-C",
            stage,
            "deny-mask",
          ],
        ]),
    [gzip, "-n", "-f", rawArchive],
  ];
  for (const command of commands) {
    const child = Bun.spawn(command, {
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error("release archive command failed");
  }
  await rename(`${rawArchive}.gz`, archivePath);
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
    const closure = await runtimeClosure(target);
    const denyFile = await copySource(payload);
    await copyRuntime(payload);
    await buildSystemDocsPublisher(payload);
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
    await createArchive(stage, archivePath, denyFile);
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
