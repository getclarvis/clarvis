import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCiWorkspaces, requireCiDirectory } from "./ci-workspaces.ts";

export interface BuildIdentity {
  commit: string;
  runId: string;
  producerAttempt: string;
  bunVersion: string;
  bunRevision: string;
  platform: string;
  arch: string;
  lockSha256: string;
}

export interface BuildProducer {
  artifactId: string;
  artifactDigest: string;
  tarDigest: string;
  attempt: string;
}

interface BuildEntry {
  path: string;
  kind: "file" | "directory";
  mode: number;
  size: number;
  sha256: string;
}

interface TarEntry extends BuildEntry {
  data: Buffer;
}

interface BuildManifest {
  schema: 1;
  identity: BuildIdentity;
  directories: string[];
  entries: BuildEntry[];
}

const MANIFEST = "ci-build-manifest.json";
const SHA256 = /^[a-f0-9]{64}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Digest the transported bytes, independently of the Actions ZIP container digest. */
export function buildDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Require the successful producer's exact outputs before download; never fall back to a name. */
export function requireBuildProducer(env: NodeJS.ProcessEnv): BuildProducer {
  const producer = {
    artifactId: env.CI_BUILD_ARTIFACT_ID,
    artifactDigest: env.CI_BUILD_ARTIFACT_DIGEST,
    tarDigest: env.CI_BUILD_TAR_DIGEST,
    attempt: env.CI_BUILD_PRODUCER_ATTEMPT,
  };
  if (
    !POSITIVE_INTEGER.test(producer.artifactId ?? "") ||
    !POSITIVE_INTEGER.test(producer.attempt ?? "") ||
    !SHA256.test(producer.artifactDigest ?? "") ||
    !SHA256.test(producer.tarDigest ?? "")
  ) {
    throw new Error(
      "Missing or invalid successful build producer outputs; rerun the complete workflow. Artifact-name fallback is forbidden.",
    );
  }
  return producer;
}

/** Attribute the checked-out commit using Git, never github.sha (which may describe a different ref). */
export async function readBuildIdentity(
  root: string,
  runId: string,
  producerAttempt: string,
): Promise<BuildIdentity> {
  if (!POSITIVE_INTEGER.test(runId ?? "") || !POSITIVE_INTEGER.test(producerAttempt ?? "")) {
    throw new Error("Build identity requires a run ID and producer attempt");
  }
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const commit = git.stdout.toString().trim();
  if (git.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Cannot identify build checkout with git rev-parse HEAD");
  return {
    commit,
    runId,
    producerAttempt,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    platform: process.platform,
    arch: process.arch,
    lockSha256: buildDigest(await readFile(join(root, "bun.lock"))),
  };
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\\:]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function inBuild(path: string, directories: string[]): boolean {
  return directories.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

async function buildDirectories(root: string): Promise<string[]> {
  return (await readCiWorkspaces(root, "build"))
    .map((workspace) => `${workspace.relative}/dist`)
    .sort();
}

async function inventory(root: string, directories: string[]): Promise<BuildEntry[]> {
  const entries: BuildEntry[] = [];
  const walk = async (path: string) => {
    if (!safePath(path)) throw new Error(`Invalid build path: ${path}`);
    const file = join(root, path);
    const info = await lstat(file);
    if (!info.isFile() && !info.isDirectory())
      throw new Error(`Build links and special files are forbidden: ${path}`);
    const mode = info.mode & 0o7777;
    if (mode > 0o777) throw new Error(`Special build permissions are forbidden: ${path}`);
    const bytes = info.isFile() ? await readFile(file) : Buffer.alloc(0);
    entries.push({
      path,
      kind: info.isFile() ? "file" : "directory",
      mode,
      size: bytes.length,
      sha256: buildDigest(bytes),
    });
    if (info.isDirectory())
      for (const name of (await readdir(file)).sort()) await walk(`${path}/${name}`);
  };
  for (const directory of directories) {
    await requireCiDirectory(root, directory);
    await walk(directory);
    if (!entries.some((entry) => entry.kind === "file" && entry.path.startsWith(`${directory}/`))) {
      throw new Error(`Build directory contains no artifacts: ${directory}`);
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Create only real CI-owned directories, refusing a preexisting symlink at any segment. */
async function prepareCiDirectory(root: string, relative: string): Promise<string> {
  let parent = root;
  for (const part of relative.split("/")) {
    const child = join(parent, part);
    try {
      await mkdir(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(child)).isDirectory())
      throw new Error(`CI staging directory is not a real directory: ${child}`);
    parent = child;
  }
  return parent;
}

/** Package the complete Linux build as strict USTAR, retaining modes and dotfiles without dependencies. */
export async function packCiBuild(
  root: string,
  identity: BuildIdentity,
): Promise<{ path: string; digest: string; bytes: number }> {
  const directories = await buildDirectories(root);
  const entries = await inventory(root, directories);
  const manifest: BuildManifest = { schema: 1, identity, directories, entries };
  const ci = await prepareCiDirectory(root, "coverage/ci");
  const temporary = await mkdtemp(join(ci, "pack-"));
  const archive = join(temporary, "linux-build.tar");
  try {
    await writeFile(join(temporary, MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
    const result = Bun.spawnSync(
      [
        "tar",
        "--format=ustar",
        "--create",
        "--file",
        archive,
        "--hard-dereference",
        "--no-recursion",
        "--null",
        "--verbatim-files-from",
        "--directory",
        resolve(root),
        "--files-from",
        "-",
        "--directory",
        temporary,
        MANIFEST,
      ],
      {
        stdin: Buffer.from(entries.map((entry) => entry.path).join("\0") + "\0"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) throw new Error(`Build tar failed: ${result.stderr.toString()}`);
    const bytes = await readFile(archive);
    validateCiBuild(bytes, identity, directories);
    const target = join(ci, "linux-build.tar");
    await rename(archive, target);
    return { path: target, digest: buildDigest(bytes), bytes: bytes.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Read only the USTAR dialect emitted above, checking header checksums before touching a destination.
 * PAX/GNU extensions, links and devices are deliberately rejected, so duplicate or aliased members
 * cannot disappear inside a general-purpose extractor's normalized inventory.
 */
function readTar(bytes: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  const string = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .split("\0")[0];
  const octal = (header: Buffer, start: number, length: number) => {
    const text = string(header, start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error("Invalid USTAR numeric field");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw new Error("Oversized USTAR numeric field");
    return value;
  };
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (
        bytes.length - offset < 1024 ||
        bytes.length % 512 ||
        !bytes.subarray(offset).every((value) => value === 0)
      )
        throw new Error("Invalid tar end marker");
      return entries;
    }
    const checksum = header.reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (checksum !== octal(header, 148, 8) || string(header, 257, 6) !== "ustar")
      throw new Error("Invalid USTAR header checksum or format");
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53)
      throw new Error("Tar links, extensions and special members are forbidden");
    if (string(header, 157, 100)) throw new Error("Tar link target is forbidden");
    const prefix = string(header, 345, 155);
    const name = string(header, 0, 100);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const path = type === 53 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (!safePath(path)) throw new Error(`Unsafe tar path: ${path}`);
    if (paths.has(path)) throw new Error(`Duplicate tar member: ${path}`);
    paths.add(path);
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    if (mode > 0o777 || (type === 53 && size !== 0))
      throw new Error(`Invalid tar mode or directory size: ${path}`);
    offset += 512;
    const next = offset + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw new Error(`Truncated tar member: ${path}`);
    const data = bytes.subarray(offset, offset + size);
    entries.push({
      path,
      kind: type === 53 ? "directory" : "file",
      mode,
      size,
      sha256: buildDigest(data),
      data,
    });
    offset = next;
  }
  throw new Error("Tar has no complete end marker");
}

/** Validate exact identity and a complete, unambiguous inventory before any build-directory mutation. */
export function validateCiBuild(
  bytes: Buffer,
  expected: BuildIdentity,
  directories: string[],
): TarEntry[] {
  const members = readTar(bytes);
  const metadata = members.find((member) => member.path === MANIFEST);
  if (!metadata || metadata.kind !== "file") throw new Error("Build manifest is missing");
  const manifest = JSON.parse(metadata.data.toString("utf8")) as BuildManifest;
  if (manifest.schema !== 1 || !manifest.identity || !Array.isArray(manifest.entries))
    throw new Error("Invalid build manifest schema");
  for (const key of Object.keys(expected) as (keyof BuildIdentity)[]) {
    if (manifest.identity[key] !== expected[key])
      throw new Error(`Build identity mismatch: ${key}`);
  }
  if (JSON.stringify(manifest.directories) !== JSON.stringify(directories))
    throw new Error("Build directory inventory mismatch");
  const entries = members.filter((member) => member.path !== MANIFEST);
  if (entries.length !== manifest.entries.length)
    throw new Error("Build member inventory mismatch");
  const declared = new Map<string, BuildEntry>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || declared.has(entry.path))
      throw new Error("Duplicate or invalid build manifest entry");
    declared.set(entry.path, entry);
  }
  for (const entry of entries) {
    if (!inBuild(entry.path, directories))
      throw new Error(`Tar member outside build scope: ${entry.path}`);
    const wanted = declared.get(entry.path);
    if (!wanted || ["kind", "mode", "size", "sha256"].some((key) => wanted[key] !== entry[key]))
      throw new Error(`Build checksum or inventory mismatch: ${entry.path}`);
    const parent = dirname(entry.path).replaceAll("\\", "/");
    if (!directories.includes(entry.path) && declared.get(parent)?.kind !== "directory")
      throw new Error(`Build parent directory is absent: ${entry.path}`);
  }
  for (const directory of directories) {
    if (
      declared.get(directory)?.kind !== "directory" ||
      !entries.some((entry) => entry.kind === "file" && entry.path.startsWith(`${directory}/`))
    )
      throw new Error(`Build directory is absent or empty: ${directory}`);
  }
  return entries;
}

/** Restore verified regular files through fresh staging, never invoking tar extraction or rebuilding. */
export async function restoreCiBuild(
  root: string,
  archive: string,
  expected: BuildIdentity,
  digest: string,
): Promise<number> {
  const bytes = await readFile(archive);
  if (!SHA256.test(digest) || buildDigest(bytes) !== digest)
    throw new Error("Build tar digest mismatch");
  const directories = await buildDirectories(root);
  const entries = validateCiBuild(bytes, expected, directories);
  const ci = await prepareCiDirectory(root, "coverage/ci");
  const temporary = await mkdtemp(join(ci, "restore-"));
  try {
    for (const entry of entries.filter((entry) => entry.kind === "directory"))
      await mkdir(join(temporary, entry.path), { recursive: true });
    for (const entry of entries.filter((entry) => entry.kind === "file")) {
      const target = join(temporary, entry.path);
      await writeFile(target, entry.data, { flag: "wx", mode: entry.mode });
      await chmod(target, entry.mode);
    }
    for (const entry of entries.filter((entry) => entry.kind === "directory").reverse())
      await chmod(join(temporary, entry.path), entry.mode);
    for (const directory of directories) {
      await requireCiDirectory(root, dirname(directory).replaceAll("\\", "/"));
      try {
        if (!(await lstat(join(root, directory))).isDirectory())
          throw new Error(`Build destination is not a real directory: ${directory}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const directory of directories) {
      await rm(join(root, directory), { recursive: true, force: true });
      await rename(join(temporary, directory), join(root, directory));
    }
    return bytes.length;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
