import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  agentsWorkspaceDir,
  configurationRoots,
  GIT_DIR,
  globalPaths,
  globalRoot as resolveGlobalRoot,
  workspacePaths,
} from "@clarvis/paths";

/** The execution mode requested by a trusted host. */
export type ExecutionMode = "host" | "sandbox";
/** Filesystem authority granted to the workspace inside a sandbox. */
export type WorkspaceAccess = "read-write" | "read-only";
/** Network authority granted to sandboxed children. */
export type NetworkAccess = "enabled" | "disabled";

/** A host-owned, immutable description of the filesystem and process boundary. */
export interface ExecutionPolicy {
  readonly id: string;
  readonly mode: ExecutionMode;
  readonly workspaceRoot: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly network: NetworkAccess;
  readonly homeRoot: string;
  readonly globalRoot: string;
  readonly globalAgentsRoot: string;
  readonly workflowsRoot: string;
  readonly settingsFile: string;
  readonly installationRoots: readonly string[];
  readonly temporaryWriteRoots: readonly string[];
  readonly additionalWriteRoots: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly denies: readonly string[];
}

/** Trusted inputs used to construct a policy; tool arguments never supply these. */
export interface ExecutionPolicyOptions {
  readonly id: string;
  readonly mode?: ExecutionMode;
  readonly workspaceRoot: string;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly network?: NetworkAccess;
  readonly homeRoot?: string;
  readonly globalRoot?: string;
  readonly installationRoots?: readonly string[];
  readonly temporaryWriteRoots?: readonly string[];
  readonly additionalWriteRoots?: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  /** Exact default metadata roots intentionally writable for one approved action. */
  readonly writableMetadataRoots?: readonly string[];
  readonly denies?: readonly string[];
}

/** Invalid policy is a setup error and must never silently become Host. */
export class InvalidExecutionPolicy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExecutionPolicy";
  }
}

const issuedPolicies = new WeakSet<object>();

/** Reject objects that did not pass the host-side policy constructor. */
export function assertExecutionPolicy(policy: ExecutionPolicy): void {
  if (!issuedPolicies.has(policy)) {
    throw new InvalidExecutionPolicy("execution policy was not issued by the policy constructor");
  }
}

function absolute(value: string, label: string): string {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new InvalidExecutionPolicy(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function existingDirectory(value: string, label: string): string {
  const path = absolute(value, label);
  try {
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    return realpathSync(path);
  } catch {
    throw new InvalidExecutionPolicy(`${label} must be an existing directory`);
  }
}

function paths(values: readonly string[], label: string): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => absolute(value, label)))]);
}

function canonicalTarget(value: string, label: string): string {
  const path = absolute(value, label);
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() && !existsSync(path)) {
      throw new InvalidExecutionPolicy(`${label} is a dangling symlink`);
    }
    if (!statSync(path).isDirectory()) {
      throw new InvalidExecutionPolicy(`${label} is not a directory`);
    }
    return realpathSync(path);
  } catch (error) {
    if (error instanceof InvalidExecutionPolicy) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new InvalidExecutionPolicy(`${label} has no existing ancestor`);
  return join(canonicalTarget(parent, label), basename(path));
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === sep ? root : `${root}${sep}`);
}

/**
 * Resolve host-owned path vocabulary and reject malformed authority before launch.
 * The host filesystem is readable by default. Installation roots identify
 * trusted product code that must remain outside sandbox-writable paths.
 */
export function createExecutionPolicy(options: ExecutionPolicyOptions): ExecutionPolicy {
  if (!options.id || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.id)) {
    throw new InvalidExecutionPolicy("id must be a bounded policy identifier");
  }
  const mode = options.mode ?? "host";
  const workspaceAccess = options.workspaceAccess ?? "read-write";
  const network = options.network ?? "enabled";
  if (mode !== "host" && mode !== "sandbox") throw new InvalidExecutionPolicy("invalid mode");
  if (workspaceAccess !== "read-write" && workspaceAccess !== "read-only") {
    throw new InvalidExecutionPolicy("invalid workspace access");
  }
  if (network !== "enabled" && network !== "disabled") {
    throw new InvalidExecutionPolicy("invalid network access");
  }
  const workspaceRoot = existingDirectory(options.workspaceRoot, "workspaceRoot");
  const homeRoot = existingDirectory(options.homeRoot ?? homedir(), "homeRoot");
  const roots = configurationRoots({
    workspaceRoot,
    home: homeRoot,
    globalDir: options.globalRoot ?? resolveGlobalRoot({ home: homeRoot }),
  });
  const globalRoot = canonicalTarget(roots.global_clarvis, "globalRoot");
  if (globalRoot === "/tmp" || globalRoot === "/dev/shm") {
    throw new InvalidExecutionPolicy("globalRoot conflicts with a protected or writable root");
  }
  const global = globalPaths(globalRoot);
  const temporaryWriteRoots = paths(options.temporaryWriteRoots ?? [], "temporaryWriteRoots");
  const additionalWriteRoots = paths(options.additionalWriteRoots ?? [], "additionalWriteRoots");
  const installationRoots = Object.freeze(
    (options.installationRoots ?? []).map((root) => existingDirectory(root, "installationRoot")),
  );
  if (installationRoots.some((root) => within(root, globalRoot))) {
    throw new InvalidExecutionPolicy("read-only roots cannot expose private global state");
  }
  const writableRoots = [
    workspaceRoot,
    "/tmp",
    "/dev/shm",
    ...temporaryWriteRoots,
    ...additionalWriteRoots,
  ].map((root) => canonicalTarget(root, "writableRoot"));
  if (installationRoots.some((root) => writableRoots.some((writable) => within(writable, root)))) {
    throw new InvalidExecutionPolicy("installationRoot overlaps a sandbox-writable path");
  }
  const gitMetadata = join(workspaceRoot, GIT_DIR);
  let externalGitDir: string | undefined;
  if (existsSync(gitMetadata) && statSync(gitMetadata).isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitMetadata, "utf8"));
    if (match) externalGitDir = resolve(workspaceRoot, match[1]!);
  }
  const defaultReadOnlyPaths = paths(
    [
      gitMetadata,
      workspacePaths(workspaceRoot).clarvisDir,
      agentsWorkspaceDir(workspaceRoot),
      join(workspaceRoot, ".aws"),
      ...(externalGitDir ? [externalGitDir] : []),
    ],
    "readOnlyPaths",
  );
  const writableMetadataRoots = paths(options.writableMetadataRoots ?? [], "writableMetadataRoots");
  if (writableMetadataRoots.some((root) => !defaultReadOnlyPaths.includes(root))) {
    throw new InvalidExecutionPolicy("writableMetadataRoots must name default metadata roots");
  }
  const readOnlyPaths = paths(
    [
      ...defaultReadOnlyPaths.filter((root) => !writableMetadataRoots.includes(root)),
      ...(options.readOnlyPaths ?? []),
    ],
    "readOnlyPaths",
  );
  const policy = Object.freeze({
    id: options.id,
    mode,
    workspaceRoot,
    workspaceAccess,
    network,
    homeRoot,
    globalRoot,
    globalAgentsRoot: roots.global_agents,
    workflowsRoot: global.workflowsDir,
    settingsFile: global.settingsFile,
    installationRoots,
    temporaryWriteRoots,
    additionalWriteRoots,
    readOnlyPaths,
    denies: paths(options.denies ?? [], "denies"),
  });
  issuedPolicies.add(policy);
  return policy;
}
