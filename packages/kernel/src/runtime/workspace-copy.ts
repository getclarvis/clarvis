import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AGENTS_DIR, CLARVIS_DIR, DIR_MODE, GIT_DIR } from "@clarvis/paths";

/** One independently verified entry in a retained workspace tree. */
export type WorkspaceManifestEntry =
  | {
      readonly path: string;
      readonly type: "file";
      readonly mode: number;
      readonly size: number;
      readonly digest: string;
    }
  | {
      readonly path: string;
      readonly type: "symlink";
      readonly mode: number;
      readonly target: string;
    };

/** Stable manifest used as the baseline for host-side change detection. */
export interface WorkspaceManifest {
  readonly version: 1;
  readonly entries: readonly WorkspaceManifestEntry[];
  readonly digest: string;
}

/** Bounds applied before copying or reviewing guest-controlled content. */
export interface WorkspaceScanLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_WORKSPACE_SCAN_LIMITS: WorkspaceScanLimits = {
  maxEntries: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

/** Typed refusal for unsafe or over-bound workspace input. */
export class WorkspaceCopyError extends Error {
  readonly code:
    | "invalid_root"
    | "unsupported_entry"
    | "unsafe_symlink"
    | "nested_mount"
    | "entry_limit"
    | "file_size_limit"
    | "total_size_limit"
    | "destination_exists";

  constructor(code: WorkspaceCopyError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCopyError";
    this.code = code;
  }
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifestDigest(entries: readonly WorkspaceManifestEntry[]): string {
  return digestBytes(Buffer.from(JSON.stringify(entries)));
}

/** Validate an untrusted persisted manifest, including its canonical digest. */
export function isWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return false;
  const entries: WorkspaceManifestEntry[] = [];
  let prior = "";
  for (const valueEntry of candidate.entries as unknown[]) {
    if (typeof valueEntry !== "object" || valueEntry === null) return false;
    const entry = valueEntry as Record<string, unknown>;
    if (typeof entry.path !== "string") return false;
    if (!confinedRelative(entry.path) || entry.path <= prior) return false;
    prior = entry.path;
    if (
      typeof entry.mode !== "number" ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      return false;
    }
    if (entry.type === "file") {
      if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        return false;
      }
      if (typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) {
        return false;
      }
      entries.push({
        path: entry.path,
        type: "file",
        mode: entry.mode,
        size: entry.size,
        digest: entry.digest,
      });
    } else if (entry.type === "symlink") {
      if (typeof entry.target !== "string" || isAbsolute(entry.target)) return false;
      entries.push({ path: entry.path, type: "symlink", mode: entry.mode, target: entry.target });
    } else {
      return false;
    }
  }
  return typeof candidate.digest === "string" && candidate.digest === manifestDigest(entries);
}

function excludedRootEntry(name: string): boolean {
  return name === GIT_DIR || name === CLARVIS_DIR || name === AGENTS_DIR;
}

function confinedRelative(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Scan a workspace without trusting a guest-produced change report. */
export async function scanRuntimeWorkspace(
  root: string,
  limits: WorkspaceScanLimits = DEFAULT_WORKSPACE_SCAN_LIMITS,
): Promise<WorkspaceManifest> {
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot).catch((cause: unknown) => {
    throw new WorkspaceCopyError("invalid_root", "workspace root is unavailable", { cause });
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkspaceCopyError("invalid_root", "workspace root must be a real directory");
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const entries: WorkspaceManifestEntry[] = [];
  let totalBytes = 0;

  async function visit(directory: string, prefix: string): Promise<void> {
    const opened = await opendir(directory);
    const children = [];
    for await (const child of opened) children.push(child.name);
    children.sort();
    for (const name of children) {
      if (prefix === "" && excludedRootEntry(name)) continue;
      const relativePath = prefix === "" ? name : join(prefix, name);
      const absolutePath = join(directory, name);
      const info = await lstat(absolutePath);
      if (info.dev !== rootInfo.dev) {
        throw new WorkspaceCopyError(
          "nested_mount",
          `workspace entry crosses a device: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entries.length >= limits.maxEntries) {
        throw new WorkspaceCopyError("entry_limit", "workspace entry limit exceeded");
      }
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        if (isAbsolute(target)) {
          throw new WorkspaceCopyError(
            "unsafe_symlink",
            `absolute symlink refused: ${relativePath}`,
          );
        }
        const resolvedTarget = await realpath(absolutePath).catch((cause: unknown) => {
          throw new WorkspaceCopyError(
            "unsafe_symlink",
            `unresolved symlink refused: ${relativePath}`,
            {
              cause,
            },
          );
        });
        const fromRoot = relative(canonicalRoot, resolvedTarget);
        if (!confinedRelative(fromRoot)) {
          throw new WorkspaceCopyError(
            "unsafe_symlink",
            `escaping symlink refused: ${relativePath}`,
          );
        }
        entries.push({ path: relativePath, type: "symlink", mode, target });
        continue;
      }
      if (!info.isFile() || info.nlink > 1) {
        throw new WorkspaceCopyError(
          "unsupported_entry",
          `workspace entry must be a regular non-hardlinked file: ${relativePath}`,
        );
      }
      if (info.size > limits.maxFileBytes) {
        throw new WorkspaceCopyError(
          "file_size_limit",
          `workspace file is too large: ${relativePath}`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new WorkspaceCopyError("total_size_limit", "workspace total size limit exceeded");
      }
      const bytes = await readFile(absolutePath);
      entries.push({
        path: relativePath,
        type: "file",
        mode,
        size: bytes.byteLength,
        digest: digestBytes(bytes),
      });
    }
  }

  await visit(absoluteRoot, "");
  return { version: 1, entries, digest: manifestDigest(entries) };
}

/** Capture exact eligible workspace contents into a new retained directory. */
export async function captureRuntimeWorkspace(
  sourceRoot: string,
  destinationRoot: string,
  limits: WorkspaceScanLimits = DEFAULT_WORKSPACE_SCAN_LIMITS,
): Promise<WorkspaceManifest> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const relation = relative(source, destination);
  const inverse = relative(destination, source);
  if (
    destination === source ||
    (!relation.startsWith("..") && relation !== "") ||
    (!inverse.startsWith("..") && inverse !== "")
  ) {
    throw new WorkspaceCopyError("invalid_root", "workspace copy must be separate from its source");
  }
  if (
    await lstat(destination).then(
      () => true,
      () => false,
    )
  ) {
    throw new WorkspaceCopyError("destination_exists", "workspace copy destination already exists");
  }
  const manifest = await scanRuntimeWorkspace(source, limits);
  const staging = `${destination}.capture-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: DIR_MODE });
  try {
    for (const entry of manifest.entries) {
      const from = join(source, entry.path);
      const to = join(staging, entry.path);
      await mkdir(dirname(to), { recursive: true, mode: DIR_MODE });
      if (entry.type === "symlink") {
        await symlink(entry.target, to);
      } else {
        await copyFile(from, to);
        await chmod(to, entry.mode);
      }
    }
    const copied = await scanRuntimeWorkspace(staging, limits);
    if (copied.digest !== manifest.digest) {
      throw new WorkspaceCopyError("unsupported_entry", "workspace changed while it was captured");
    }
    await mkdir(dirname(destination), { recursive: true, mode: DIR_MODE });
    await rename(staging, destination);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** One complete accumulated tree delta relative to a host-held baseline. */
export interface WorkspaceChangeSet {
  readonly id: string;
  readonly baselineDigest: string;
  readonly currentDigest: string;
  readonly added: readonly WorkspaceManifestEntry[];
  readonly modified: readonly WorkspaceManifestEntry[];
  readonly deleted: readonly WorkspaceManifestEntry[];
}

/** Compare independently scanned manifests without consulting Git or guest reports. */
export function diffRuntimeWorkspace(
  baseline: WorkspaceManifest,
  current: WorkspaceManifest,
): WorkspaceChangeSet {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const added: WorkspaceManifestEntry[] = [];
  const modified: WorkspaceManifestEntry[] = [];
  const deleted: WorkspaceManifestEntry[] = [];
  for (const entry of current.entries) {
    const prior = before.get(entry.path);
    if (prior === undefined) added.push(entry);
    else if (JSON.stringify(prior) !== JSON.stringify(entry)) modified.push(entry);
  }
  for (const entry of baseline.entries) {
    if (!after.has(entry.path)) deleted.push(entry);
  }
  const identity = {
    baselineDigest: baseline.digest,
    currentDigest: current.digest,
    added,
    modified,
    deleted,
  };
  return {
    id: digestBytes(Buffer.from(JSON.stringify(identity))),
    ...identity,
  };
}
