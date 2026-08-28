import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { RELEASE_REPOSITORY, type ReleaseTarget } from "../update-contract.ts";

/** The first portable-release manifest format. */
export const RELEASE_MANIFEST_SCHEMA = 1;

/** A regular payload file covered by the release manifest. */
export interface ReleaseManifestFile {
  path: string;
  size: number;
  sha256: string;
}

/** The integrity and identity contract embedded in every portable archive. */
export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  repository: typeof RELEASE_REPOSITORY;
  version: string;
  target: ReleaseTarget;
  files: readonly ReleaseManifestFile[];
}

/** Decide whether a portable path identifies a source-map payload. */
export function isReleaseSourceMapPath(value: string): boolean {
  return /\.map$/i.test(value);
}

/** Decide whether generated text embeds a source map as a data URL. */
export function containsInlineSourceMap(value: string): boolean {
  return /sourceMappingURL\s*=\s*data:/i.test(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

/** Decide whether an archive member is a confined portable relative path. */
export function isPortableReleasePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    containsControlCharacter(value)
  ) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Decode a release manifest while enforcing bounded files, paths, sizes and hashes. */
export function parseReleaseManifest(
  value: unknown,
  expected: { version: string; target: ReleaseTarget },
): ReleaseManifest {
  const record = object(value);
  if (
    record?.schema !== RELEASE_MANIFEST_SCHEMA ||
    record.repository !== RELEASE_REPOSITORY ||
    record.version !== expected.version ||
    record.target !== expected.target ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > 4_096
  ) {
    throw new Error("release manifest identity or shape is invalid");
  }
  const seen = new Set<string>();
  const files: ReleaseManifestFile[] = [];
  for (const value of record.files) {
    const file = object(value);
    if (
      file === undefined ||
      typeof file.path !== "string" ||
      !isPortableReleasePath(file.path) ||
      isReleaseSourceMapPath(file.path) ||
      file.path === "release.json" ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      Number(file.size) > 512 * 1024 * 1024 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      seen.has(file.path)
    ) {
      throw new Error("release manifest contains an invalid file entry");
    }
    seen.add(file.path);
    files.push({ path: file.path, size: Number(file.size), sha256: file.sha256 });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    repository: RELEASE_REPOSITORY,
    version: expected.version,
    target: expected.target,
    files,
  };
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`release payload contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`release payload contains a non-regular entry: ${path}`);
    }
  };
  await visit(root);
  return files.sort();
}

function confinedPath(root: string, portablePath: string): string {
  const candidate = resolve(root, ...portablePath.split("/"));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!candidate.startsWith(prefix))
    throw new Error(`release path escapes payload: ${portablePath}`);
  return candidate;
}

/** Compute the deterministic manifest entries for every regular file under a staged payload. */
export async function manifestFiles(root: string): Promise<ReleaseManifestFile[]> {
  const files: ReleaseManifestFile[] = [];
  for (const path of await regularFiles(root)) {
    const portablePath = relative(root, path).split(sep).join("/");
    if (portablePath === "release.json") continue;
    if (!isPortableReleasePath(portablePath)) {
      throw new Error(`release payload path is not portable: ${portablePath}`);
    }
    if (isReleaseSourceMapPath(portablePath)) {
      throw new Error(`release payload contains a source map: ${portablePath}`);
    }
    const bytes = await readFile(path);
    files.push({
      path: portablePath,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return files;
}

/** Verify a staged payload has exactly the regular files and hashes declared by its manifest. */
export async function verifyReleaseTree(root: string, manifest: ReleaseManifest): Promise<void> {
  const actual = await regularFiles(root);
  const actualPortable = actual
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => path !== "release.json")
    .sort();
  const expectedPortable = manifest.files.map((file) => file.path).sort();
  if (actualPortable.length !== expectedPortable.length) {
    throw new Error("release payload file count does not match its manifest");
  }
  for (let index = 0; index < expectedPortable.length; index++) {
    if (actualPortable[index] !== expectedPortable[index]) {
      throw new Error("release payload contains an undeclared or missing file");
    }
  }
  for (const file of manifest.files) {
    const path = confinedPath(root, file.path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== file.size) throw new Error(`release file size mismatch: ${file.path}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) throw new Error(`release file checksum mismatch: ${file.path}`);
  }
}
