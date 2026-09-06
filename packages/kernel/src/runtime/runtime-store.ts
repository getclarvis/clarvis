import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DIR_MODE,
  FILE_MODE,
  acquireLocalLease,
  workspaceStatePaths,
  writeFileDurable,
  type RootOptions,
} from "@clarvis/paths";
import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";

import {
  captureRuntimeWorkspace,
  isWorkspaceManifest,
  scanRuntimeWorkspace,
  type WorkspaceManifest,
  type WorkspaceScanLimits,
} from "./workspace-copy.ts";
import { createPrivateRuntimeGit } from "./private-git.ts";

const MAX_RECORD_BYTES = 256 * 1024;

/** Durable host record for one retained runtime generation. */
export interface RuntimeRecord {
  readonly version: 1;
  readonly runtimeId: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly sourceWorkspaceRoot: string;
  readonly retainedWorkspaceRoot: string;
  readonly baselineDigest: string;
  readonly state: "prepared" | "active" | "stopped" | "failed" | "cleanup_pending";
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A prepared generation reconstructed from host-owned durable state. */
export interface PreparedRuntimeWorkspace {
  readonly record: RuntimeRecord;
  readonly baseline: WorkspaceManifest;
}

const STATE_TRANSITIONS: Readonly<
  Record<RuntimeRecord["state"], readonly RuntimeRecord["state"][]>
> = {
  prepared: ["active", "failed"],
  active: ["stopped", "failed", "cleanup_pending"],
  stopped: ["active", "cleanup_pending"],
  failed: ["active", "cleanup_pending"],
  cleanup_pending: ["stopped"],
};

/** Inputs whose identities are assigned by the host before path translation. */
export interface PrepareRuntimeWorkspaceOptions {
  readonly runtimeId: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly sourceWorkspaceRoot: string;
  readonly roots?: RootOptions;
  readonly limits?: WorkspaceScanLimits;
  readonly now?: () => number;
}

/** Typed persistence or reconstruction refusal. */
export class RuntimeStoreError extends Error {
  readonly code: "runtime_exists" | "runtime_in_use" | "runtime_corrupt" | "runtime_not_found";

  constructor(code: RuntimeStoreError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeStoreError";
    this.code = code;
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimeStoreError("runtime_not_found", "runtime state does not exist", { cause });
    }
    throw cause;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime state file is unsafe or oversized");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime state is not valid JSON", { cause });
  }
}

function isProject(value: unknown): value is ProjectRef {
  return (
    typeof value === "object" && value !== null && typeof (value as ProjectRef).id === "string"
  );
}

function isWorkspace(value: unknown): value is WorkspaceRef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as WorkspaceRef;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.label === "string" &&
    (candidate.kind === "primary" || candidate.kind === "external_worktree")
  );
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as RuntimeRecord;
  return (
    candidate.version === 1 &&
    typeof candidate.runtimeId === "string" &&
    typeof candidate.ownerId === "string" &&
    isProject(candidate.project) &&
    isWorkspace(candidate.workspace) &&
    candidate.workspace.projectId === candidate.project.id &&
    typeof candidate.sourceWorkspaceRoot === "string" &&
    typeof candidate.retainedWorkspaceRoot === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(candidate.baselineDigest) &&
    ["prepared", "active", "stopped", "failed", "cleanup_pending"].includes(candidate.state) &&
    Number.isSafeInteger(candidate.createdAt) &&
    Number.isSafeInteger(candidate.updatedAt)
  );
}

interface RuntimeRegistry {
  readonly version: 1;
  readonly runtimes: readonly string[];
}

function isRegistry(value: unknown): value is RuntimeRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RuntimeRegistry).version === 1 &&
    Array.isArray((value as RuntimeRegistry).runtimes) &&
    (value as RuntimeRegistry).runtimes.every((id) => typeof id === "string")
  );
}

async function readRegistry(path: string): Promise<RuntimeRegistry> {
  try {
    const value = await readBoundedJson(path);
    if (!isRegistry(value))
      throw new RuntimeStoreError("runtime_corrupt", "runtime registry is invalid");
    return value;
  } catch (error) {
    if (error instanceof RuntimeStoreError && error.code === "runtime_not_found") {
      return { version: 1, runtimes: [] };
    }
    throw error;
  }
}

/** Capture and durably register a new retained runtime generation. */
export async function prepareRuntimeWorkspace(
  options: PrepareRuntimeWorkspaceOptions,
): Promise<PreparedRuntimeWorkspace> {
  const sourceWorkspaceRoot = resolve(options.sourceWorkspaceRoot);
  const paths = workspaceStatePaths(sourceWorkspaceRoot, options.roots);
  const runtimeDir = paths.runtimeDir(options.runtimeId);
  if (
    await lstat(runtimeDir).then(
      () => true,
      () => false,
    )
  ) {
    throw new RuntimeStoreError("runtime_exists", "runtime generation already exists");
  }
  await mkdir(paths.runtimesDir, { recursive: true, mode: DIR_MODE });
  const lease = await acquireLocalLease(`${paths.runtimeRegistryFile}.lock`, {
    staleMs: 30_000,
    waitMs: 2_000,
    retryMs: 25,
    heartbeatMs: 5_000,
  });
  if (lease === null) throw new RuntimeStoreError("runtime_in_use", "runtime registry is in use");
  try {
    const registry = await readRegistry(paths.runtimeRegistryFile);
    if (registry.runtimes.includes(options.runtimeId)) {
      throw new RuntimeStoreError("runtime_exists", "runtime generation is already registered");
    }
    const baseline = await captureRuntimeWorkspace(
      sourceWorkspaceRoot,
      paths.runtimeWorkspaceDir(options.runtimeId),
      options.limits,
    );
    try {
      await createPrivateRuntimeGit(
        sourceWorkspaceRoot,
        paths.runtimeWorkspaceDir(options.runtimeId),
      );
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true });
      throw error;
    }
    const now = (options.now ?? Date.now)();
    const record: RuntimeRecord = {
      version: 1,
      runtimeId: options.runtimeId,
      ownerId: options.ownerId,
      project: options.project,
      workspace: options.workspace,
      sourceWorkspaceRoot,
      retainedWorkspaceRoot: paths.runtimeWorkspaceDir(options.runtimeId),
      baselineDigest: baseline.digest,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await writeFileDurable(paths.runtimeBaselineFile(options.runtimeId), serialize(baseline), {
        mode: FILE_MODE,
        dirMode: DIR_MODE,
      });
      await writeFileDurable(paths.runtimeRecordFile(options.runtimeId), serialize(record), {
        mode: FILE_MODE,
        dirMode: DIR_MODE,
      });
      await lease.assertOwned();
      await writeFileDurable(
        paths.runtimeRegistryFile,
        serialize({ version: 1, runtimes: [...registry.runtimes, options.runtimeId] }),
        { mode: FILE_MODE, dirMode: DIR_MODE },
      );
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true });
      throw error;
    }
    return { record, baseline };
  } finally {
    await lease.release();
  }
}

/** Reconstruct and verify one retained generation from host state after guest loss. */
export async function loadRuntimeWorkspace(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  roots?: RootOptions,
  limits?: WorkspaceScanLimits,
): Promise<PreparedRuntimeWorkspace> {
  const paths = workspaceStatePaths(sourceWorkspaceRoot, roots);
  const [recordValue, baselineValue] = await Promise.all([
    readBoundedJson(paths.runtimeRecordFile(runtimeId)),
    readBoundedJson(paths.runtimeBaselineFile(runtimeId)),
  ]);
  if (!isRuntimeRecord(recordValue) || !isWorkspaceManifest(baselineValue)) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime record or baseline is invalid");
  }
  if (
    recordValue.runtimeId !== runtimeId ||
    recordValue.sourceWorkspaceRoot !== sourceWorkspaceRoot ||
    recordValue.retainedWorkspaceRoot !== paths.runtimeWorkspaceDir(runtimeId) ||
    recordValue.baselineDigest !== baselineValue.digest
  ) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime identity does not match its host path");
  }
  const current = await scanRuntimeWorkspace(recordValue.retainedWorkspaceRoot, limits);
  if (recordValue.state === "prepared" && current.digest !== baselineValue.digest) {
    throw new RuntimeStoreError(
      "runtime_corrupt",
      "prepared runtime workspace differs from baseline",
    );
  }
  return { record: recordValue, baseline: baselineValue };
}

/** Persist a legal host-observed generation transition. */
export async function setRuntimeState(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  state: RuntimeRecord["state"],
  roots?: RootOptions,
  now: () => number = Date.now,
): Promise<RuntimeRecord> {
  const paths = workspaceStatePaths(sourceWorkspaceRoot, roots);
  const lease = await acquireLocalLease(`${paths.runtimeRecordFile(runtimeId)}.lock`, {
    staleMs: 30_000,
    waitMs: 2_000,
    retryMs: 25,
    heartbeatMs: 5_000,
  });
  if (lease === null) throw new RuntimeStoreError("runtime_in_use", "runtime record is in use");
  try {
    const current = await loadRuntimeWorkspace(sourceWorkspaceRoot, runtimeId, roots);
    if (!STATE_TRANSITIONS[current.record.state].includes(state)) {
      throw new RuntimeStoreError(
        "runtime_corrupt",
        `invalid runtime transition ${current.record.state} -> ${state}`,
      );
    }
    const next: RuntimeRecord = { ...current.record, state, updatedAt: now() };
    await lease.assertOwned();
    await writeFileDurable(paths.runtimeRecordFile(runtimeId), serialize(next), {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    });
    return next;
  } finally {
    await lease.release();
  }
}

/** Idempotently advance the retained baseline after a journaled host apply. */
export async function commitRuntimeBaseline(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  previousDigest: string,
  baseline: WorkspaceManifest,
  roots?: RootOptions,
  now: () => number = Date.now,
): Promise<RuntimeRecord> {
  const paths = workspaceStatePaths(sourceWorkspaceRoot, roots);
  const value = await readBoundedJson(paths.runtimeRecordFile(runtimeId));
  if (!isRuntimeRecord(value) || value.runtimeId !== runtimeId) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime record is invalid during settlement");
  }
  if (value.baselineDigest !== previousDigest && value.baselineDigest !== baseline.digest) {
    throw new RuntimeStoreError("runtime_corrupt", "runtime baseline changed during settlement");
  }
  const next: RuntimeRecord = {
    ...value,
    baselineDigest: baseline.digest,
    updatedAt: value.baselineDigest === baseline.digest ? value.updatedAt : now(),
  };
  await writeFileDurable(paths.runtimeBaselineFile(runtimeId), serialize(baseline), {
    mode: FILE_MODE,
    dirMode: DIR_MODE,
  });
  await writeFileDurable(paths.runtimeRecordFile(runtimeId), serialize(next), {
    mode: FILE_MODE,
    dirMode: DIR_MODE,
  });
  return next;
}
