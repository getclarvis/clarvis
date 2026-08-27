#!/usr/bin/env bun
/** Install, reinstall and uninstall the native archive through the public installer contract. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  return stdout + stderr;
}

function assertVisibleProgress(output: string): void {
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
    await mkdir(join(unmanagedLauncher, ".."), { recursive: true });
    await writeFile(unmanagedLauncher, "unmanaged launcher\n");
    const refused = await refusal(installer, environment);
    if (
      !refused.includes("unmanaged") ||
      (await stat(join(installRoot, "current")).catch(() => undefined)) !== undefined
    ) {
      throw new Error("installer collision changed the active release or lacked a bounded error");
    }
    const unsafeUninstall = await refusal(uninstaller, environment);
    if (
      !unsafeUninstall.includes("not an authenticated Clarvis installation") ||
      (await stat(installRoot).catch(() => undefined)) === undefined
    ) {
      throw new Error("uninstaller removed an unauthenticated installation root");
    }
    await rm(unmanagedLauncher);

    const markerPath = join(installRoot, ".clarvis-managed-install");
    await writeFile(markerPath, "not the Clarvis marker\n");
    const invalidMarker = await refusal(uninstaller, environment);
    if (!invalidMarker.includes("invalid managed marker")) {
      throw new Error("uninstaller accepted an invalid ownership marker");
    }
    await rm(markerPath);

    const lock = join(installRoot, "update.lock");
    await writeFile(lock, "prior owner\n");
    const lockedInstall = await refusal(installer, environment);
    if (
      !lockedInstall.includes("another Clarvis install, update, or uninstall is active") ||
      (await stat(join(installRoot, "current")).catch(() => undefined)) !== undefined
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
    const current = await readFile(join(installRoot, "current"), "utf8");
    if (current !== `v${product.version}\n`)
      throw new Error("installer did not activate the release");
    const marker = await readFile(markerPath, "utf8");
    if (marker !== "managed by getclarvis/clarvis installer\n") {
      throw new Error("installer did not write its ownership marker");
    }
    await rm(markerPath);
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
      (await stat(join(installRoot, "current")).catch(() => undefined)) !== undefined ||
      (await stat(markerPath).catch(() => undefined)) !== undefined ||
      (await stat(unmanagedLauncher).catch(() => undefined)) !== undefined
    ) {
      throw new Error("uninstaller left managed application files behind");
    }
    if ((await readFile(unrelatedRootFile, "utf8")) !== "keep me\n") {
      throw new Error("uninstaller changed an unknown install-root file");
    }
    if ((await readFile(userState, "utf8")) !== '{"preserve":true}\n') {
      throw new Error("uninstaller changed Clarvis user state");
    }
    const secondUninstall = await run(uninstaller, environment);
    if (!secondUninstall.includes("nothing to remove")) {
      throw new Error("repeated uninstall was not a clean no-op");
    }
    process.stdout.write(
      `installer smoke ok - ${target} installed, reinstalled, and uninstalled ${product.version}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
