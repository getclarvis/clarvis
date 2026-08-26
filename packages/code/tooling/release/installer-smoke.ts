#!/usr/bin/env bun
/** Install the native archive from a local mirror and verify the stable launcher twice. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseAssetName, releaseTarget } from "../../src/update-contract.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");

async function run(
  command: string[],
  environment: Record<string, string>,
  stdin?: string,
): Promise<void> {
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
  if (code === 0) throw new Error("installer overwrote an unmanaged launcher");
  return stdout + stderr;
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
  };
  try {
    const installer =
      process.platform === "win32"
        ? ["pwsh", "-NoProfile", "-File", join(repositoryRoot, "install.ps1")]
        : ["/bin/sh", join(repositoryRoot, "install.sh")];
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
    await rm(unmanagedLauncher);

    if (process.platform === "win32") {
      for (let attempt = 0; attempt < 2; attempt++) {
        await run(installer, environment);
      }
      const launcher = join(installRoot, "bin", "clarvis.cmd");
      const output = await capture(["cmd.exe", "/d", "/c", launcher, "--version"], environment);
      if (output.trim() !== `clarvis ${product.version}`)
        throw new Error("Windows launcher drifted");
    } else {
      await chmod(join(repositoryRoot, "install.sh"), 0o755);
      await run(
        ["/bin/sh"],
        environment,
        await readFile(join(repositoryRoot, "install.sh"), "utf8"),
      );
      await run(installer, environment);
      const launcher = join(binDirectory, "clarvis");
      const output = await capture([launcher, "--version"], environment);
      if (output !== `clarvis ${product.version}\n`) throw new Error("POSIX launcher drifted");
    }
    const current = await readFile(join(installRoot, "current"), "utf8");
    if (current !== `v${product.version}\n`)
      throw new Error("installer did not activate the release");
    process.stdout.write(
      `installer smoke ok - ${target} installed and reinstalled ${product.version}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
