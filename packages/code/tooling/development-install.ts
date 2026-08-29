import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
const launcherName = "clarvis-develop";
export const DEVELOPMENT_LAUNCHER_MARKER = "# clarvis-develop managed launcher v1";
export const DEVELOPMENT_TEMP_ROOT = "/tmp/clarvis-development-temp";
const DEVELOPMENT_TEMP_MARKER = ".clarvis-development-temp-root";
const DEVELOPMENT_TEMP_MARKER_CONTENT = "clarvis-develop temporary workspaces v1\n";

export interface DevelopmentInstallRequest {
  mode: "help" | "install" | "clear-only" | "create-empty-workspace" | "uninstall";
  clear: boolean;
}

/** Parse the deliberately small maintenance surface shared by the shell entry and launcher. */
export function parseDevelopmentInstallArgs(args: readonly string[]): DevelopmentInstallRequest {
  let clear = false;
  let mode: DevelopmentInstallRequest["mode"] = "install";
  for (const argument of args) {
    if (argument === "--clear") {
      clear = true;
    } else if (argument === "--clear-only") {
      if (mode !== "install") throw new Error("--clear-only cannot be combined with another mode");
      mode = "clear-only";
    } else if (argument === "--create-empty-workspace") {
      if (mode !== "install") {
        throw new Error("--create-empty-workspace cannot be combined with another mode");
      }
      mode = "create-empty-workspace";
    } else if (argument === "--uninstall") {
      if (mode !== "install") throw new Error("--uninstall cannot be combined with another mode");
      mode = "uninstall";
    } else if (argument === "--help" || argument === "-h") {
      if (mode !== "install") throw new Error("--help cannot be combined with another mode");
      mode = "help";
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (mode !== "install" && clear) throw new Error("--clear is available only during installation");
  return { mode, clear };
}

/** Render help without loading the application or altering the checkout. */
export function developmentInstallHelp(): string {
  return [
    "Usage: ./dev-install.sh [--clear | --uninstall | --help]",
    "",
    `Install ${launcherName} from this checkout without building or downloading a release.`,
    "",
    "  --clear      delete global state and managed temporary workspaces before installing",
    `  --uninstall  remove only the managed ${launcherName} launcher`,
    "  --help       print this help and exit",
    "",
    `After installation, run ${launcherName} from the project you want Clarvis to operate on.`,
    `Run ${launcherName} --empty-workspace to open a new directory below ${DEVELOPMENT_TEMP_ROOT}.`,
    `Run ${launcherName} --clear to delete global state and every managed temporary workspace.`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Build the installed POSIX launcher.
 *
 * @remarks Ordinary runs keep the caller's current directory as the Clarvis workspace. Only the
 * explicit empty-workspace mode changes directory, after allocating its authenticated temp path.
 */
export function developmentLauncherSource(input: { repository: string; bun: string }): string {
  const repository = shellQuote(resolve(input.repository));
  const bun = shellQuote(resolve(input.bun));
  return [
    "#!/bin/sh",
    DEVELOPMENT_LAUNCHER_MARKER,
    "set -eu",
    `repository=${repository}`,
    `bun=${bun}`,
    'if [ ! -f "$repository/packages/code/src/cli.ts" ]; then',
    `  printf '%s\\n' "${launcherName}: source checkout not found at $repository; rerun ./dev-install.sh from its new location" >&2`,
    "  exit 1",
    "fi",
    'if [ ! -x "$bun" ]; then',
    `  printf '%s\\n' "${launcherName}: Bun not found at $bun; rerun ./dev-install.sh" >&2`,
    "  exit 1",
    "fi",
    "clear=0",
    "empty_workspace=0",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    --clear) clear=1; shift ;;",
    "    --empty-workspace) empty_workspace=1; shift ;;",
    "    --) shift; break ;;",
    "    *) break ;;",
    "  esac",
    "done",
    'if [ "$clear" -eq 1 ]; then',
    '  "$bun" "$repository/packages/code/tooling/development-install.ts" --clear-only',
    '  if [ "$empty_workspace" -eq 0 ] && [ "$#" -eq 0 ]; then exit 0; fi',
    "fi",
    'if [ "$empty_workspace" -eq 1 ]; then',
    '  workspace=$("$bun" "$repository/packages/code/tooling/development-install.ts" --create-empty-workspace)',
    `  printf '%s\\n' "${launcherName}: using empty workspace $workspace"`,
    '  cd -- "$workspace"',
    "fi",
    "export CLARVIS_CODE_SOURCE=1",
    'exec "$bun" "$repository/packages/code/src/cli.ts" "$@"',
    "",
  ].join("\n");
}

async function existingLauncher(path: string): Promise<"absent" | "managed"> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`refusing to replace non-regular launcher at ${path}`);
    }
    const source = await readFile(path, "utf8");
    if (!source.includes(DEVELOPMENT_LAUNCHER_MARKER)) {
      throw new Error(`refusing to replace unmanaged launcher at ${path}`);
    }
    return "managed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Install or update the owned launcher atomically without replacing an unrelated command. */
export async function installDevelopmentLauncher(input: {
  repository: string;
  bun: string;
  binDirectory: string;
}): Promise<string> {
  const binDirectory = resolve(input.binDirectory);
  const launcher = join(binDirectory, launcherName);
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await existingLauncher(launcher);
  const temporary = `${launcher}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, developmentLauncherSource(input), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o755,
    });
    await rename(temporary, launcher);
  } finally {
    await rm(temporary, { force: true });
  }
  return launcher;
}

/** Remove only a regular launcher carrying this installer's ownership marker. */
export async function uninstallDevelopmentLauncher(binDirectory: string): Promise<boolean> {
  const launcher = join(resolve(binDirectory), launcherName);
  if ((await existingLauncher(launcher)) === "absent") return false;
  await unlink(launcher);
  return true;
}

function within(parent: string, child: string): boolean {
  const segment = relative(parent, child);
  return (
    segment !== "" && segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment)
  );
}

/**
 * Permanently remove the selected Clarvis global state after proving it is a real directory below
 * the user's home, never the home itself, a linked directory, or an external target.
 */
export async function cleanDevelopmentState(target: string, userHome: string): Promise<boolean> {
  const resolvedTarget = resolve(target);
  const resolvedHome = resolve(userHome);
  if (!within(resolvedHome, resolvedTarget)) {
    throw new Error(`refusing to clean global state outside the user home: ${resolvedTarget}`);
  }
  try {
    const status = await lstat(resolvedTarget);
    if (status.isSymbolicLink()) {
      throw new Error(`refusing to clean linked global state: ${resolvedTarget}`);
    }
    if (!status.isDirectory()) {
      throw new Error(`refusing to clean non-directory global state: ${resolvedTarget}`);
    }
    const [physicalHome, physicalTarget] = await Promise.all([
      realpath(resolvedHome),
      realpath(resolvedTarget),
    ]);
    if (!within(physicalHome, physicalTarget)) {
      throw new Error(
        `refusing to clean global state outside the physical user home: ${physicalTarget}`,
      );
    }
    await rm(resolvedTarget, { recursive: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ownedByCurrentUser(status: Awaited<ReturnType<typeof lstat>>): boolean {
  return typeof process.getuid !== "function" || status.uid === process.getuid();
}

async function validateDevelopmentTempRoot(root: string): Promise<"absent" | "managed"> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`refusing unmanaged temporary-workspace root: ${root}`);
  }
  if (!ownedByCurrentUser(status)) {
    throw new Error(`refusing temporary-workspace root owned by another user: ${root}`);
  }
  const marker = join(root, DEVELOPMENT_TEMP_MARKER);
  try {
    const markerStatus = await lstat(marker);
    if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) {
      throw new Error(`refusing temporary-workspace root with invalid marker: ${root}`);
    }
    if ((await readFile(marker, "utf8")) !== DEVELOPMENT_TEMP_MARKER_CONTENT) {
      throw new Error(`refusing temporary-workspace root with invalid marker: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`refusing temporary-workspace root with invalid marker: ${root}`, {
        cause: error,
      });
    }
    throw error;
  }
  return "managed";
}

/** Create and authenticate the fixed root before allocating one new empty workspace below it. */
export async function createEmptyDevelopmentWorkspace(
  root = DEVELOPMENT_TEMP_ROOT,
): Promise<string> {
  const resolvedRoot = resolve(root);
  if ((await validateDevelopmentTempRoot(resolvedRoot)) === "absent") {
    await mkdir(resolvedRoot, { recursive: false, mode: 0o700 });
    await writeFile(join(resolvedRoot, DEVELOPMENT_TEMP_MARKER), DEVELOPMENT_TEMP_MARKER_CONTENT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  await validateDevelopmentTempRoot(resolvedRoot);
  return await mkdtemp(join(resolvedRoot, "workspace-"));
}

/** Remove the complete authenticated temporary-workspace root and nothing outside it. */
export async function clearDevelopmentTempWorkspaces(
  root = DEVELOPMENT_TEMP_ROOT,
): Promise<boolean> {
  const resolvedRoot = resolve(root);
  if ((await validateDevelopmentTempRoot(resolvedRoot)) === "absent") return false;
  await rm(resolvedRoot, { recursive: true });
  return true;
}

function developmentBinDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  return resolve(
    environment.CLARVIS_DEV_BIN_DIR ?? environment.XDG_BIN_HOME ?? join(home, ".local", "bin"),
  );
}

function canonicalBunVersion(source: string): string {
  const version = /^bun\s*=\s*"([^"]+)"\s*$/m.exec(source)?.[1];
  if (version === undefined) throw new Error("mise.toml does not declare the pinned Bun version");
  return version;
}

function run(command: readonly string[], cwd: string): void {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("cannot run an empty command");
  const child = spawnSync(executable, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${String(child.status)}`);
  }
}

function repositoryHookIsConfigured(): boolean {
  const child = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (child.error !== undefined) throw child.error;
  if (child.status === 1) return false;
  if (child.status !== 0) {
    throw new Error(
      `git config --local --get core.hooksPath failed with exit ${String(child.status)}`,
    );
  }
  return child.stdout.trim() === ".githooks";
}

async function cleanEffectiveGlobalState(): Promise<void> {
  const { globalRoot } = await import("@clarvis/paths");
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const target = globalRoot();
  const removed = await cleanDevelopmentState(target, userHome);
  console.log(
    removed ? `Removed global Clarvis state at ${target}.` : `No global state found at ${target}.`,
  );
}

async function clearDevelopmentEnvironment(): Promise<void> {
  await cleanEffectiveGlobalState();
  const removed = await clearDevelopmentTempWorkspaces();
  console.log(
    removed
      ? `Removed managed temporary workspaces at ${DEVELOPMENT_TEMP_ROOT}.`
      : `No managed temporary workspaces found at ${DEVELOPMENT_TEMP_ROOT}.`,
  );
}

async function verifyLauncher(launcher: string): Promise<void> {
  const child = spawnSync(launcher, ["--version"], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0 || !child.stdout.startsWith("clarvis ")) {
    throw new Error(
      `${launcher} --version failed with exit ${String(child.status)}: ${child.stderr.trim()}`,
    );
  }
  console.log(child.stdout.trim());
}

async function main(): Promise<void> {
  const request = parseDevelopmentInstallArgs(process.argv.slice(2));
  if (request.mode === "help") {
    console.log(developmentInstallHelp());
    return;
  }

  const binDirectory = developmentBinDirectory();
  if (request.mode === "clear-only") {
    await clearDevelopmentEnvironment();
    return;
  }
  if (request.mode === "create-empty-workspace") {
    process.stdout.write(`${await createEmptyDevelopmentWorkspace()}\n`);
    return;
  }
  if (request.mode === "uninstall") {
    const removed = await uninstallDevelopmentLauncher(binDirectory);
    console.log(
      removed
        ? `Removed managed ${launcherName} launcher from ${binDirectory}.`
        : `No managed ${launcherName} launcher found in ${binDirectory}.`,
    );
    return;
  }

  const expected = canonicalBunVersion(await readFile(join(repositoryRoot, "mise.toml"), "utf8"));
  const steps = request.clear ? 6 : 5;
  console.log(`[1/${steps}] Checking Bun ${expected}.`);
  if (Bun.version !== expected) {
    throw new Error(
      `Clarvis development requires Bun ${expected}; this process is Bun ${Bun.version}`,
    );
  }

  console.log(`[2/${steps}] Installing dependencies from the frozen lockfile.`);
  run([process.execPath, "install", "--frozen-lockfile"], repositoryRoot);

  console.log(`[3/${steps}] Configuring the repository Git hook.`);
  if (repositoryHookIsConfigured()) {
    console.log("Repository Git hook is already configured.");
  } else {
    run([process.execPath, "run", "hooks:install"], repositoryRoot);
  }

  let step = 4;
  if (request.clear) {
    console.log(`[${step}/${steps}] Clearing global state and managed temporary workspaces.`);
    await clearDevelopmentEnvironment();
    step += 1;
  }

  console.log(`[${step}/${steps}] Installing the source launcher.`);
  const launcher = await installDevelopmentLauncher({
    repository: repositoryRoot,
    bun: process.execPath,
    binDirectory,
  });

  console.log(`[${step + 1}/${steps}] Verifying the source launcher.`);
  await verifyLauncher(launcher);
  console.log(`Installed ${launcherName} at ${launcher}.`);
  console.log(`It runs the current checkout at ${repositoryRoot} directly from source.`);
  if (!(process.env.PATH ?? "").split(delimiter).includes(binDirectory)) {
    console.log(`Add ${binDirectory} to PATH before invoking ${launcherName}.`);
  }
  console.log(
    `Use '${launcherName} --empty-workspace' to test in a new directory below ${DEVELOPMENT_TEMP_ROOT}.`,
  );
  console.log(`Use '${launcherName} --clear' to reset global state and temporary workspaces.`);
  console.log(`Use './dev-install.sh --uninstall' to remove only this launcher.`);
}

if (import.meta.main) {
  await main();
}
