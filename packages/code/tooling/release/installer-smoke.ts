#!/usr/bin/env bun
/** Install, reinstall and uninstall the native archive through the public installer contract. */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { globalPaths } from "@clarvis/paths";

import { releaseAssetName, releaseTarget } from "../../src/update-contract.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");

async function run(
  command: string[],
  environment: Record<string, string>,
  stdin?: string,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const input = child.stdin;
  if (stdin !== undefined) {
    if (input === undefined) throw new Error("installer stdin pipe was not created");
    await input.write(stdin);
    await input.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `installer command failed (${String(code)}): ${command.join(" ")}\n${stdout}\n${stderr}`,
    );
  }
  return stdout + stderr;
}

async function refusal(command: string[], environment: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code === 0) throw new Error("installer command unexpectedly succeeded");
  return normalizeInstallerOutput(stdout + stderr);
}

function withoutAnsiCsi(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== "[") {
      result += value[index];
      continue;
    }
    index += 2;
    while (index < value.length) {
      const codePoint = value.charCodeAt(index);
      if (codePoint >= 0x40 && codePoint <= 0x7e) break;
      index += 1;
    }
  }
  return result;
}

/** Normalize semantic installer output when PowerShell styles and wraps a long error. */
export function normalizeInstallerOutput(output: string): string {
  return withoutAnsiCsi(output)
    .replace(/\r?\n\s*\|\s*/g, " ")
    .replace(/\s+/g, " ");
}

/** Match semantic installer output even when PowerShell styles and wraps a long error. */
export function installerOutputIncludes(output: string, expected: string): boolean {
  return normalizeInstallerOutput(output).includes(expected);
}

function assertVisibleProgress(output: string): void {
  if (/setting locale failed|unsupported locale setting/i.test(output)) {
    throw new Error("installer inherited an unavailable locale into an archive command");
  }
  for (const expected of [
    "Clarvis installer",
    "[1/8] Detected the",
    "Obtaining release checksums",
    "Verifying the archive SHA-256 checksum",
    "Testing staged Clarvis",
    "Activating Clarvis",
  ]) {
    if (!output.includes(expected)) {
      throw new Error(`installer output did not expose the ${expected} step`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, `${lines.join("\n")}\n`);
  await chmod(path, 0o755);
}

async function assertPosixCancellationStopsUninstall(
  uninstaller: string[],
  environment: Record<string, string>,
  versions: string,
  marker: string,
  current: string,
  launcher: string,
): Promise<void> {
  const installRoot = environment.CLARVIS_INSTALL_ROOT;
  if (installRoot === undefined) throw new Error("CLARVIS_INSTALL_ROOT is required");
  const realRm = Bun.which("rm");
  if (realRm === null) throw new Error("rm is unavailable for the cancellation regression");
  const commandDirectory = join(dirname(installRoot), "signal-bin");
  await mkdir(commandDirectory, { recursive: true });
  await writeExecutable(join(commandDirectory, "rm"), [
    "#!/bin/sh",
    'if [ "$#" -eq 2 ] && [ "$1" = "-rf" ] && [ "$2" = "$CLARVIS_SIGNAL_TARGET" ]; then',
    '  kill -TERM "$PPID"',
    "  exit 0",
    "fi",
    'exec "$CLARVIS_REAL_RM" "$@"',
  ]);
  const output = await refusal(uninstaller, {
    ...environment,
    CLARVIS_REAL_RM: realRm,
    CLARVIS_SIGNAL_TARGET: versions,
    PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ""}`,
  });
  if (output.includes("uninstalled Clarvis")) {
    throw new Error("signal cancellation continued into a successful uninstall");
  }
  for (const path of [versions, marker, current, launcher]) {
    if (!(await pathExists(path))) throw new Error(`signal cancellation removed ${path}`);
  }
  if (await pathExists(join(installRoot, "update.lock"))) {
    throw new Error("signal cancellation left the operation lock behind");
  }
}

async function assertPosixStaleLauncherUsesLock(
  uninstaller: string[],
  environment: Record<string, string>,
  launcher: string,
): Promise<void> {
  const installRoot = environment.CLARVIS_INSTALL_ROOT;
  if (installRoot === undefined) throw new Error("CLARVIS_INSTALL_ROOT is required");
  const realMkdir = Bun.which("mkdir");
  if (realMkdir === null) throw new Error("mkdir is unavailable for the stale-launcher regression");
  const commandDirectory = join(dirname(installRoot), "lock-bin");
  await mkdir(commandDirectory, { recursive: true });
  await writeExecutable(join(commandDirectory, "mkdir"), [
    "#!/bin/sh",
    'if [ "$#" -eq 2 ] && [ "$1" = "-p" ] && [ "$2" = "$CLARVIS_STALE_ROOT" ]; then',
    '  "$CLARVIS_REAL_MKDIR" "$@"',
    '  printf "%s\\n" "concurrent owner" >"$2/update.lock"',
    "  exit 0",
    "fi",
    'exec "$CLARVIS_REAL_MKDIR" "$@"',
  ]);
  const refused = await refusal(uninstaller, {
    ...environment,
    CLARVIS_REAL_MKDIR: realMkdir,
    CLARVIS_STALE_ROOT: installRoot,
    PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ""}`,
  });
  if (
    !refused.includes("another Clarvis install, update, or uninstall is active") ||
    !(await pathExists(launcher))
  ) {
    throw new Error("stale-launcher uninstall did not coordinate through the shared lock");
  }
  await rm(installRoot, { recursive: true, force: true });
  const removed = await run(uninstaller, environment);
  if (!removed.includes("uninstalled the stale Clarvis launcher") || (await pathExists(launcher))) {
    throw new Error("stale managed launcher was not removed under the shared lock");
  }
}

async function readWindowsUserPath(environment: Record<string, string>): Promise<string | null> {
  const serialized = await run(
    [
      "pwsh",
      "-NoProfile",
      "-Command",
      "[Console]::Out.Write((ConvertTo-Json -Compress ([Environment]::GetEnvironmentVariable('Path', 'User'))))",
    ],
    environment,
  );
  return JSON.parse(serialized) as string | null;
}

async function writeWindowsUserPath(
  environment: Record<string, string>,
  value: string | null,
): Promise<void> {
  await run(
    [
      "pwsh",
      "-NoProfile",
      "-Command",
      "$value = if ($env:CLARVIS_TEST_USER_PATH_IS_NULL -eq '1') { $null } else { $env:CLARVIS_TEST_USER_PATH }; [Environment]::SetEnvironmentVariable('Path', $value, 'User')",
    ],
    {
      ...environment,
      CLARVIS_TEST_USER_PATH: value ?? "",
      CLARVIS_TEST_USER_PATH_IS_NULL: value === null ? "1" : "0",
    },
  );
}

function windowsPathContains(path: string | null, expected: string): boolean {
  return (path ?? "")
    .split(";")
    .some((entry) => entry.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0);
}

async function capture(command: string[], environment: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, {
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 || stderr !== "") throw new Error(`installed launcher failed: ${stderr}`);
  return stdout;
}

async function main(): Promise<void> {
  const target = releaseTarget();
  if (target === undefined) throw new Error("native platform is not a release target");
  const product = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const releaseDirectory = join(repositoryRoot, "build", "release");
  const asset = releaseAssetName(product.version, target);
  const sidecar = (await readFile(join(releaseDirectory, `${asset}.sha256`), "utf8")).trim();
  await writeFile(join(releaseDirectory, "SHA256SUMS"), `${sidecar}\n`);
  const temporary = await mkdtemp(join(tmpdir(), "clarvis-installer-smoke-"));
  const installRoot = join(temporary, "install");
  const binDirectory = join(temporary, "bin");
  const environment = {
    CLARVIS_RELEASE_DIRECTORY: releaseDirectory,
    CLARVIS_INSTALL_ROOT: installRoot,
    CLARVIS_BIN_DIR: binDirectory,
    CLARVIS_SKIP_PATH: "1",
    LC_ALL: "C.UTF-8",
    HOME: join(temporary, "home"),
    USERPROFILE: join(temporary, "home"),
  };
  try {
    const installer =
      process.platform === "win32"
        ? ["pwsh", "-NoProfile", "-File", join(repositoryRoot, "install.ps1")]
        : ["/bin/sh", join(repositoryRoot, "install.sh")];
    const uninstaller =
      process.platform === "win32" ? [...installer, "-Uninstall"] : [...installer, "--uninstall"];
    const help = await run(
      process.platform === "win32" ? [...installer, "-Help"] : [...installer, "--help"],
      environment,
    );
    if (!help.includes("Usage:") || !help.toLowerCase().includes("uninstall")) {
      throw new Error("installer help did not expose uninstall mode");
    }
    const unmanagedLauncher =
      process.platform === "win32"
        ? join(installRoot, "bin", "clarvis.cmd")
        : join(binDirectory, "clarvis");
    const currentPath = join(installRoot, "current");
    const markerPath = join(installRoot, ".clarvis-managed-install");
    const versionsPath = join(installRoot, "versions");
    await mkdir(join(unmanagedLauncher, ".."), { recursive: true });
    await writeFile(unmanagedLauncher, "unmanaged launcher\n");
    const refused = await refusal(installer, environment);
    if (
      !refused.includes("unmanaged") ||
      (await stat(currentPath).catch(() => undefined)) !== undefined
    ) {
      throw new Error("installer collision changed the active release or lacked a bounded error");
    }
    await mkdir(installRoot, { recursive: true });
    await writeFile(currentPath, "not a managed activation\n");
    const unsafeUninstall = await refusal(uninstaller, environment);
    const installRootPreserved = await pathExists(installRoot);
    if (
      !installerOutputIncludes(unsafeUninstall, "not an authenticated Clarvis installation") ||
      !installRootPreserved
    ) {
      throw new Error(
        `uninstaller mishandled an unauthenticated installation root: root_preserved=${String(installRootPreserved)} output=${JSON.stringify(unsafeUninstall)}`,
      );
    }
    await rm(currentPath);
    await rm(unmanagedLauncher);

    await writeFile(markerPath, "not the Clarvis marker\n");
    const invalidMarker = await refusal(uninstaller, environment);
    if (!invalidMarker.includes("invalid managed marker")) {
      throw new Error("uninstaller accepted an invalid ownership marker");
    }
    await rm(markerPath);

    await mkdir(markerPath);
    const markerDirectory = await refusal(installer, environment);
    if (!markerDirectory.includes("not a regular managed marker")) {
      throw new Error("installer accepted a marker destination directory");
    }
    await rm(markerPath, { recursive: true });

    const markerTarget = join(temporary, "marker-target");
    await mkdir(markerTarget);
    await symlink(markerTarget, markerPath, process.platform === "win32" ? "junction" : "dir");
    const markerLink = await refusal(installer, environment);
    if (
      !markerLink.includes("not a regular managed marker") ||
      (await readdir(markerTarget)).length !== 0
    ) {
      throw new Error("installer traversed a linked marker destination");
    }
    await rm(markerPath, { recursive: true });

    const lock = join(installRoot, "update.lock");
    await writeFile(lock, "prior owner\n");
    const lockedInstall = await refusal(installer, environment);
    if (
      !lockedInstall.includes("another Clarvis install, update, or uninstall is active") ||
      (await stat(currentPath).catch(() => undefined)) !== undefined
    ) {
      throw new Error("installer ignored the shared update lock");
    }
    await rm(lock);

    const userState = globalPaths(undefined, {
      env: {},
      home: join(temporary, "home"),
    }).settingsFile;
    await mkdir(dirname(userState), { recursive: true });
    await writeFile(userState, '{"preserve":true}\n');

    if (process.platform === "win32") {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertVisibleProgress(await run(installer, environment));
      }
      const launcher = join(installRoot, "bin", "clarvis.cmd");
      const output = await capture(["cmd.exe", "/d", "/c", launcher, "--version"], environment);
      if (output.trim() !== `clarvis ${product.version}`)
        throw new Error("Windows launcher drifted");
    } else {
      await chmod(join(repositoryRoot, "install.sh"), 0o755);
      const source = await readFile(join(repositoryRoot, "install.sh"), "utf8");
      assertVisibleProgress(await run(["/bin/sh"], environment, source));
      assertVisibleProgress(await run(installer, environment));
      const launcher = join(binDirectory, "clarvis");
      const output = await capture([launcher, "--version"], environment);
      if (output !== `clarvis ${product.version}\n`) throw new Error("POSIX launcher drifted");
    }
    const current = await readFile(currentPath, "utf8");
    if (current !== `v${product.version}\n`)
      throw new Error("installer did not activate the release");
    const marker = await readFile(markerPath, "utf8");
    if (marker !== "managed by getclarvis/clarvis installer\n") {
      throw new Error("installer did not write its ownership marker");
    }

    const savedVersions = join(temporary, "saved-versions");
    const linkedVersionsTarget = join(temporary, "linked-versions-target");
    await rename(versionsPath, savedVersions);
    await mkdir(linkedVersionsTarget);
    await writeFile(join(linkedVersionsTarget, "preserve.txt"), "outside payload\n");
    await symlink(
      linkedVersionsTarget,
      versionsPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedVersions = await refusal(uninstaller, environment);
    if (
      !linkedVersions.includes("not a regular managed directory") ||
      (await readFile(join(linkedVersionsTarget, "preserve.txt"), "utf8")) !== "outside payload\n"
    ) {
      throw new Error("uninstaller accepted or traversed a linked versions directory");
    }
    await rm(versionsPath, { recursive: true });
    await rename(savedVersions, versionsPath);

    if (process.platform !== "win32") {
      await assertPosixCancellationStopsUninstall(
        uninstaller,
        environment,
        versionsPath,
        markerPath,
        currentPath,
        unmanagedLauncher,
      );
    }

    const unrelatedRootFile = join(installRoot, "operator-note.txt");
    await writeFile(unrelatedRootFile, "keep me\n");

    await writeFile(lock, "prior owner\n");
    const lockedUninstall = await refusal(uninstaller, environment);
    if (
      !lockedUninstall.includes("another Clarvis install, update, or uninstall is active") ||
      (await stat(installRoot).catch(() => undefined)) === undefined
    ) {
      throw new Error("uninstaller ignored the shared update lock");
    }
    await rm(lock);

    const unrelatedLauncherText = "unrelated launcher kept by uninstall\n";
    await writeFile(unmanagedLauncher, unrelatedLauncherText);

    const uninstallOutput =
      process.platform === "win32"
        ? await run(uninstaller, environment)
        : await run(
            ["/bin/sh", "-s", "--", "--uninstall"],
            environment,
            await readFile(join(repositoryRoot, "install.sh"), "utf8"),
          );
    if (
      !uninstallOutput.includes("Clarvis uninstaller") ||
      !uninstallOutput.includes("[3/3] Removing managed releases") ||
      !uninstallOutput.includes(
        "configuration, credentials, sessions, and project data were preserved",
      )
    ) {
      throw new Error("uninstaller output did not expose removal and state-retention behavior");
    }
    if (
      (await stat(join(installRoot, "versions")).catch(() => undefined)) !== undefined ||
      (await stat(currentPath).catch(() => undefined)) !== undefined ||
      (await stat(markerPath).catch(() => undefined)) !== undefined
    ) {
      throw new Error("uninstaller left managed application files behind");
    }
    if ((await readFile(unmanagedLauncher, "utf8")) !== unrelatedLauncherText) {
      throw new Error("uninstaller changed an unrelated launcher");
    }
    if ((await readFile(unrelatedRootFile, "utf8")) !== "keep me\n") {
      throw new Error("uninstaller changed an unknown install-root file");
    }
    if ((await readFile(userState, "utf8")) !== '{"preserve":true}\n') {
      throw new Error("uninstaller changed Clarvis user state");
    }
    const secondUninstall = await run(uninstaller, environment);
    if (
      !secondUninstall.includes("nothing to remove") ||
      (await readFile(unmanagedLauncher, "utf8")) !== unrelatedLauncherText
    ) {
      throw new Error("repeated uninstall was not a preserving no-op");
    }

    await rm(unmanagedLauncher);
    assertVisibleProgress(await run(installer, environment));
    await rm(markerPath);
    const legacyUninstall = await run(uninstaller, environment);
    if (
      !legacyUninstall.includes("uninstalled Clarvis") ||
      (await pathExists(versionsPath)) ||
      (await pathExists(currentPath)) ||
      (await pathExists(unmanagedLauncher))
    ) {
      throw new Error("legacy pre-marker installation was not safely uninstalled");
    }

    if (process.platform === "win32") {
      const originalUserPath = await readWindowsUserPath(environment);
      const testUserPath =
        originalUserPath === null
          ? null
          : originalUserPath
              .split(";")
              .filter(
                (entry) =>
                  entry.localeCompare(join(installRoot, "bin"), undefined, {
                    sensitivity: "accent",
                  }) !== 0,
              )
              .join(";");
      try {
        await writeWindowsUserPath(environment, testUserPath);
        const pathEnvironment = { ...environment, CLARVIS_SKIP_PATH: "0" };
        assertVisibleProgress(await run(installer, pathEnvironment));
        const managedBin = join(installRoot, "bin");
        if (!windowsPathContains(await readWindowsUserPath(environment), managedBin)) {
          throw new Error("Windows installer did not add its managed PATH entry");
        }
        await rm(unmanagedLauncher);
        const missingLauncherUninstall = await run(uninstaller, pathEnvironment);
        if (
          !missingLauncherUninstall.includes(`removed ${managedBin} from the user PATH`) ||
          windowsPathContains(await readWindowsUserPath(environment), managedBin)
        ) {
          throw new Error("Windows uninstall left PATH behind after the launcher disappeared");
        }
      } finally {
        await writeWindowsUserPath(environment, originalUserPath);
      }
    } else {
      assertVisibleProgress(await run(installer, environment));
      const boundLauncher = await readFile(unmanagedLauncher, "utf8");
      const otherRootEnvironment = {
        ...environment,
        CLARVIS_INSTALL_ROOT: join(temporary, "other-install"),
      };
      const otherRootNoop = await run(uninstaller, otherRootEnvironment);
      if (
        !otherRootNoop.includes("nothing to remove") ||
        (await readFile(unmanagedLauncher, "utf8")) !== boundLauncher
      ) {
        throw new Error("uninstall removed a launcher bound to another install root");
      }
      const otherRootInstall = await refusal(installer, otherRootEnvironment);
      if (!otherRootInstall.includes("belongs to a different install root")) {
        throw new Error("installer overwrote a launcher bound to another install root");
      }
      const stillActive = await capture([unmanagedLauncher, "--version"], environment);
      if (stillActive !== `clarvis ${product.version}\n`) {
        throw new Error("cross-root operations changed the active launcher");
      }
      await rm(installRoot, { recursive: true, force: true });
      await assertPosixStaleLauncherUsesLock(uninstaller, environment, unmanagedLauncher);
    }
    process.stdout.write(
      `installer smoke ok - ${target} guarded install and uninstall passed for ${product.version}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
