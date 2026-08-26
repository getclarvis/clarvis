#!/usr/bin/env bun

import { lstat, readFile, readlink, unlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

function canonicalBunVersion(mise: string): string {
  const match = /^bun\s*=\s*["']([^"']+)["']/m.exec(mise);
  if (match?.[1] === undefined) throw new Error("mise.toml does not declare an exact Bun version");
  return match[1];
}

function run(command: string[], cwd: string): void {
  const process = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (process.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${String(process.exitCode)}`);
  }
}

async function removeOwnedLegacyBin(binDirectory: string): Promise<void> {
  const legacy = join(binDirectory, "clarvis-code");
  try {
    if (!(await lstat(legacy)).isSymbolicLink()) return;
    const target = await readlink(legacy);
    const resolvedTarget = resolve(dirname(legacy), target);
    const ownedTarget = resolve(
      binDirectory,
      "..",
      "install",
      "global",
      "node_modules",
      "@clarvis",
      "code",
      "src",
      "cli.ts",
    );
    if (resolvedTarget !== ownedTarget) return;
    await unlink(legacy);
    console.log("Removed the package-owned legacy 'clarvis-code' link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const expected = canonicalBunVersion(await readFile(join(repositoryRoot, "mise.toml"), "utf8"));
  if (Bun.version !== expected) {
    throw new Error(`Clarvis requires Bun ${expected}; this process is Bun ${Bun.version}`);
  }

  console.log(`Using Bun ${Bun.version}.`);
  run(["bun", "install", "--frozen-lockfile"], repositoryRoot);
  run(["bun", "--filter", "@clarvis/code", "build:install"], repositoryRoot);

  const userHome = process.env.HOME ?? process.env.USERPROFILE;
  const bunInstall =
    process.env.BUN_INSTALL ?? (userHome === undefined ? undefined : join(userHome, ".bun"));
  if (bunInstall === undefined) {
    throw new Error("BUN_INSTALL, HOME, or USERPROFILE is required to locate Bun's global bin");
  }
  const binDirectory = join(bunInstall, "bin");
  await removeOwnedLegacyBin(binDirectory);

  run(["bun", "unlink"], packageRoot);
  run(["bun", "link"], packageRoot);

  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  console.log("Installed the 'clarvis' command with a map-free application bundle.");
  if (!pathEntries.includes(binDirectory)) {
    console.log(`Add ${binDirectory} to PATH in your shell configuration before invoking clarvis.`);
  }
}

await main();
