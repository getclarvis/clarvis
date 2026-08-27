import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ReleaseTarget } from "../update-contract.ts";
import { parseReleaseManifest, verifyReleaseTree } from "./release-manifest.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 8 * 1024;

/** A managed installation resolved from the stable launcher environment. */
export interface ManagedInstallation {
  root: string;
  versions: string;
  currentTag: string;
}

async function readSmallText(path: string, limit: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`managed file is invalid: ${path}`);
  return readFile(path, "utf8");
}

/** Resolve and authenticate the versioned install root without touching Clarvis user state. */
export async function managedInstallation(
  environment: NodeJS.ProcessEnv,
  currentVersion: string,
  target: ReleaseTarget,
): Promise<ManagedInstallation> {
  if (environment.CLARVIS_CODE_SOURCE === "1") {
    throw new Error(
      "source checkouts are not self-updatable; update with Git, then run bun --filter @clarvis/code setup",
    );
  }
  const rawRoot = environment.CLARVIS_INSTALL_ROOT;
  if (rawRoot === undefined || !isAbsolute(rawRoot)) {
    throw new Error(
      "this Clarvis command is not a managed release; reinstall from https://github.com/getclarvis/clarvis-releases/releases",
    );
  }
  const root = resolve(rawRoot);
  const currentTag = (await readSmallText(join(root, "current"), 128)).trim();
  if (currentTag !== `v${currentVersion}`) {
    throw new Error(
      `the active installation changed while clarvis ${currentVersion} was running (current: ${currentTag})`,
    );
  }
  const currentRoot = join(root, "versions", currentTag);
  const manifestText = await readSmallText(join(currentRoot, "release.json"), MAX_MANIFEST_BYTES);
  parseReleaseManifest(JSON.parse(manifestText), { version: currentVersion, target });
  return { root, versions: join(root, "versions"), currentTag };
}

/** Hold the install-root update lease for one operation and always release it on normal failure. */
export async function withUpdateLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(root, "update.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`another Clarvis update is active; if it crashed, remove ${lockPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await lock.writeFile(`${String(process.pid)} ${new Date().toISOString()}\n`);
    await lock.sync();
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

/** Create a private same-filesystem staging directory beneath the managed versions root. */
export async function createUpdateStage(versions: string): Promise<string> {
  await mkdir(versions, { recursive: true, mode: 0o700 });
  return mkdtemp(join(versions, ".update-"));
}

/** Extract a trusted-digest tarball through Bun's traversal-safe archive reader. */
export async function extractReleaseArchive(archivePath: string, stage: string): Promise<string> {
  const bytes = await Bun.file(archivePath).bytes();
  const archive = new Bun.Archive(bytes);
  await archive.extract(stage);
  const topLevel = (await readdir(stage)).sort();
  if (topLevel.length !== 1 || topLevel[0] !== "clarvis") {
    throw new Error("release archive must contain only the clarvis payload");
  }
  return join(stage, "clarvis");
}

function runtimePath(root: string): string {
  return join(root, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
}

function launcherPath(root: string): string {
  return join(root, "packages", "code", "src", "cli.ts");
}

async function boundedOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_VERSION_OUTPUT_BYTES) {
      await reader.cancel();
      throw new Error("staged clarvis --version output exceeded its bound");
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function candidateEnvironment(installRoot: string): Record<string, string> {
  const names = ["HOME", "USERPROFILE", "SYSTEMROOT", "PATH", "PATHEXT", "TEMP", "TMP"];
  const environment: Record<string, string> = { CLARVIS_INSTALL_ROOT: installRoot };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Verify every staged file and prove its included runtime reports the selected version. */
export async function verifyStagedRelease(
  root: string,
  expected: { version: string; target: ReleaseTarget; installRoot: string },
): Promise<void> {
  const manifestText = await readSmallText(join(root, "release.json"), MAX_MANIFEST_BYTES);
  const manifest = parseReleaseManifest(JSON.parse(manifestText), expected);
  await verifyReleaseTree(root, manifest);
  const runtime = runtimePath(root);
  if (process.platform !== "win32") await chmod(runtime, 0o755);
  const child = Bun.spawn([runtime, launcherPath(root), "--version"], {
    cwd: root,
    env: candidateEnvironment(expected.installRoot),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    boundedOutput(child.stdout),
    boundedOutput(child.stderr),
    child.exited,
  ]);
  if (exitCode !== 0 || stdout !== `clarvis ${expected.version}\n` || stderr !== "") {
    throw new Error(`staged clarvis version smoke failed with exit ${String(exitCode)}`);
  }
}

async function durableCurrent(root: string, tagName: string): Promise<void> {
  const target = join(root, "current");
  const temporary = join(root, `.current-${String(process.pid)}-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${tagName}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
  if (process.platform !== "win32") {
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

/** Promote a verified payload beside older versions, then atomically activate it last. */
export async function activateStagedRelease(
  installation: ManagedInstallation,
  stagedRoot: string,
  version: string,
  target: ReleaseTarget,
): Promise<void> {
  const tagName = `v${version}`;
  const destination = join(installation.versions, tagName);
  const existing = await stat(destination).catch(() => undefined);
  if (existing === undefined) await rename(stagedRoot, destination);
  else {
    if (!existing.isDirectory()) {
      throw new Error(`release destination is not a directory: ${destination}`);
    }
    await verifyStagedRelease(destination, {
      version,
      target,
      installRoot: installation.root,
    });
  }
  await durableCurrent(installation.root, tagName);
}

/** Remove only the unique staging directory returned by {@link createUpdateStage}. */
export async function removeUpdateStage(stage: string): Promise<void> {
  await rm(stage, { recursive: true, force: true });
}
