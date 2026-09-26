import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { configurationRoots, globalPaths, globalRoot as resolveGlobalRoot } from "@clarvis/paths";

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

const PRIVATE_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".config",
  ".gnupg",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".git-credentials",
] as const;

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

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
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
  if (
    globalRoot === "/tmp" ||
    globalRoot === "/dev/shm" ||
    within(workspaceRoot, globalRoot) ||
    within(globalRoot, roots.global_agents) ||
    PRIVATE_HOME_PATHS.some((name) => within(globalRoot, resolve(homeRoot, name)))
  ) {
    throw new InvalidExecutionPolicy("globalRoot conflicts with a protected or writable root");
  }
  const global = globalPaths(globalRoot);
  const fixedDenies = PRIVATE_HOME_PATHS.map((name) => resolve(homeRoot, name));
  const temporaryWriteRoots = paths(options.temporaryWriteRoots ?? [], "temporaryWriteRoots");
  if (
    temporaryWriteRoots.some((root) => canonicalTarget(root, "temporaryWriteRoot") === globalRoot)
  ) {
    throw new InvalidExecutionPolicy("temporary root cannot expose private global state");
  }
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
    roots.global_agents,
    global.workflowsDir,
    ...temporaryWriteRoots,
  ].map((root) => canonicalTarget(root, "writableRoot"));
  if (
    installationRoots.some((root) => writableRoots.some((writable) => overlaps(root, writable)))
  ) {
    throw new InvalidExecutionPolicy("installationRoot overlaps a sandbox-writable path");
  }
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
    denies: paths([...fixedDenies, ...(options.denies ?? [])], "denies"),
  });
  issuedPolicies.add(policy);
  return policy;
}
