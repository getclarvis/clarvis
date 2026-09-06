import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DIR_MODE,
  FILE_MODE,
  acquireLocalLease,
  workspaceStatePaths,
  writeFileDurable,
  type RootOptions,
} from "@clarvis/paths";

import {
  commitRuntimeBaseline,
  loadRuntimeWorkspace,
  type RuntimeRecord,
} from "./runtime-store.ts";
import {
  diffRuntimeWorkspace,
  scanRuntimeWorkspace,
  type WorkspaceChangeSet,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceScanLimits,
} from "./workspace-copy.ts";

/** A host-generated, digest-bound review of all currently pending source changes. */
export interface RuntimeWorkspaceReview {
  readonly changeSet: WorkspaceChangeSet;
  readonly current: WorkspaceManifest;
}

/** Host cancellation/fault boundary checked after journaling and before each filesystem mutation. */
export interface WorkspaceApplyControl {
  beforeOperation?(path: string): Promise<void> | void;
}

/** Typed refusal from review or optimistic application. */
export class WorkspaceApplyError extends Error {
  readonly code:
    | "no_changes"
    | "stale_review"
    | "host_conflict"
    | "apply_in_use"
    | "apply_failed"
    | "recovery_failed";

  constructor(code: WorkspaceApplyError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceApplyError";
    this.code = code;
  }
}

interface ApplyOperation {
  readonly path: string;
  readonly action: "write" | "delete";
  readonly hadBaseline: boolean;
}

interface ApplyJournal {
  readonly version: 1;
  readonly runtimeId: string;
  readonly changeSetId: string;
  readonly phase: "prepared" | "applying" | "settling" | "committed" | "rolled_back";
  readonly baselineDigest: string;
  readonly currentDigest: string;
  readonly operations: readonly ApplyOperation[];
  readonly applied: readonly string[];
  readonly currentOperation?: string;
}

function isConfinedPath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isApplyJournal(value: unknown): value is ApplyJournal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.runtimeId !== "string" ||
    typeof candidate.changeSetId !== "string" ||
    !["prepared", "applying", "settling", "committed", "rolled_back"].includes(
      String(candidate.phase),
    ) ||
    typeof candidate.baselineDigest !== "string" ||
    typeof candidate.currentDigest !== "string" ||
    !Array.isArray(candidate.operations) ||
    !Array.isArray(candidate.applied)
  ) {
    return false;
  }
  const operations = candidate.operations as unknown[];
  if (
    operations.some((raw) => {
      if (typeof raw !== "object" || raw === null) return true;
      const operation = raw as Record<string, unknown>;
      return (
        typeof operation.path !== "string" ||
        !isConfinedPath(operation.path) ||
        (operation.action !== "write" && operation.action !== "delete") ||
        typeof operation.hadBaseline !== "boolean"
      );
    })
  ) {
    return false;
  }
  if (
    (candidate.applied as unknown[]).some(
      (path) => typeof path !== "string" || !isConfinedPath(path),
    )
  ) {
    return false;
  }
  return candidate.currentOperation === undefined || typeof candidate.currentOperation === "string";
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pathDepth(path: string): number {
  return path.split(sep).length;
}

function operationsFor(changeSet: WorkspaceChangeSet): ApplyOperation[] {
  const deleted = [...changeSet.deleted]
    .sort(
      (left, right) =>
        pathDepth(right.path) - pathDepth(left.path) || right.path.localeCompare(left.path),
    )
    .map((entry) => ({ path: entry.path, action: "delete" as const, hadBaseline: true }));
  const writes = [...changeSet.modified, ...changeSet.added]
    .sort(
      (left, right) =>
        pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path),
    )
    .map((entry) => ({
      path: entry.path,
      action: "write" as const,
      hadBaseline: changeSet.modified.some((prior) => prior.path === entry.path),
    }));
  return [...deleted, ...writes];
}

async function removeEmptyParents(path: string, root: string): Promise<void> {
  let current = dirname(path);
  while (
    current !== root &&
    relative(root, current) !== "" &&
    !relative(root, current).startsWith(`..${sep}`)
  ) {
    try {
      await rm(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function materialize(
  source: string,
  target: string,
  entry: WorkspaceManifestEntry,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isDirectory()) await rm(target);
  const temporary = `${target}.runtime-apply-${randomUUID()}`;
  try {
    if (entry.type === "file") {
      await copyFile(source, temporary);
      await chmod(temporary, entry.mode);
    } else {
      await symlink(entry.target, temporary);
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function copyEntry(
  root: string,
  destination: string,
  entry: WorkspaceManifestEntry,
): Promise<void> {
  await materialize(join(root, entry.path), join(destination, entry.path), entry);
}

/** Build the complete host-held review after a modifying run stops. */
export async function reviewRuntimeWorkspace(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  roots?: RootOptions,
  limits?: WorkspaceScanLimits,
): Promise<RuntimeWorkspaceReview | null> {
  const retained = await loadRuntimeWorkspace(sourceWorkspaceRoot, runtimeId, roots, limits);
  const current = await scanRuntimeWorkspace(retained.record.retainedWorkspaceRoot, limits);
  const changeSet = diffRuntimeWorkspace(retained.baseline, current);
  if (
    changeSet.added.length === 0 &&
    changeSet.modified.length === 0 &&
    changeSet.deleted.length === 0
  ) {
    return null;
  }
  return { changeSet, current };
}

/** Apply one exact reviewed tree delta, rolling back every touched path on failure. */
export async function applyRuntimeWorkspaceReview(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  review: RuntimeWorkspaceReview,
  roots?: RootOptions,
  limits?: WorkspaceScanLimits,
  control: WorkspaceApplyControl = {},
): Promise<RuntimeRecord> {
  const source = resolve(sourceWorkspaceRoot);
  const paths = workspaceStatePaths(source, roots);
  const lease = await acquireLocalLease(`${paths.runtimeJournalFile(runtimeId)}.lock`, {
    staleMs: 30_000,
    waitMs: 2_000,
    retryMs: 25,
    heartbeatMs: 5_000,
  });
  if (lease === null) throw new WorkspaceApplyError("apply_in_use", "workspace apply is in use");
  const transaction = paths.runtimeTransactionDir(runtimeId, review.changeSet.id);
  const backup = join(transaction, "backup");
  const staged = join(transaction, "staged");
  try {
    const retained = await loadRuntimeWorkspace(source, runtimeId, roots, limits);
    const [hostCurrent, guestCurrent] = await Promise.all([
      scanRuntimeWorkspace(source, limits),
      scanRuntimeWorkspace(retained.record.retainedWorkspaceRoot, limits),
    ]);
    if (hostCurrent.digest !== retained.baseline.digest) {
      throw new WorkspaceApplyError(
        "host_conflict",
        "host workspace changed after runtime capture",
      );
    }
    const fresh = diffRuntimeWorkspace(retained.baseline, guestCurrent);
    if (fresh.id !== review.changeSet.id || guestCurrent.digest !== review.current.digest) {
      throw new WorkspaceApplyError("stale_review", "retained workspace changed after review");
    }
    const operations = operationsFor(fresh);
    await Promise.all([
      mkdir(backup, { recursive: true, mode: DIR_MODE }),
      mkdir(staged, { recursive: true, mode: DIR_MODE }),
    ]);
    const baselineByPath = new Map(retained.baseline.entries.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(guestCurrent.entries.map((entry) => [entry.path, entry]));
    for (const operation of operations) {
      const prior = baselineByPath.get(operation.path);
      if (prior !== undefined) await copyEntry(source, backup, prior);
      const next = currentByPath.get(operation.path);
      if (next !== undefined) await copyEntry(retained.record.retainedWorkspaceRoot, staged, next);
    }
    const [backupManifest, stagedManifest] = await Promise.all([
      scanRuntimeWorkspace(backup, limits),
      scanRuntimeWorkspace(staged, limits),
    ]);
    const expectedBackup = operations
      .map((operation) => baselineByPath.get(operation.path))
      .filter((entry): entry is WorkspaceManifestEntry => entry !== undefined)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const expectedStaged = operations
      .map((operation) => currentByPath.get(operation.path))
      .filter((entry): entry is WorkspaceManifestEntry => entry !== undefined)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (
      JSON.stringify(backupManifest.entries) !== JSON.stringify(expectedBackup) ||
      JSON.stringify(stagedManifest.entries) !== JSON.stringify(expectedStaged)
    ) {
      throw new WorkspaceApplyError(
        "stale_review",
        "workspace changed while apply data was staged",
      );
    }
    let journal: ApplyJournal = {
      version: 1,
      runtimeId,
      changeSetId: fresh.id,
      phase: "prepared",
      baselineDigest: retained.baseline.digest,
      currentDigest: guestCurrent.digest,
      operations,
      applied: [],
    };
    const persistJournal = async (): Promise<void> => {
      await writeFileDurable(paths.runtimeJournalFile(runtimeId), serialize(journal), {
        mode: FILE_MODE,
        dirMode: DIR_MODE,
      });
    };
    await persistJournal();
    try {
      for (const operation of operations) {
        journal = { ...journal, phase: "applying", currentOperation: operation.path };
        await persistJournal();
        await control.beforeOperation?.(operation.path);
        const target = join(source, operation.path);
        if (operation.action === "delete") {
          await rm(target, { force: true });
          await removeEmptyParents(target, source);
        } else {
          const entry = currentByPath.get(operation.path);
          if (entry === undefined) throw new Error("reviewed write has no staged entry");
          await materialize(join(staged, operation.path), target, entry);
        }
        journal = {
          ...journal,
          applied: [...journal.applied, operation.path],
          currentOperation: undefined,
        };
        await persistJournal();
      }
    } catch (cause) {
      const touched = new Set([
        ...journal.applied,
        ...(journal.currentOperation ? [journal.currentOperation] : []),
      ]);
      try {
        for (const operation of [...operations].reverse()) {
          if (!touched.has(operation.path)) continue;
          const target = join(source, operation.path);
          await rm(target, { recursive: true, force: true });
          const prior = baselineByPath.get(operation.path);
          if (prior !== undefined) await materialize(join(backup, operation.path), target, prior);
          else await removeEmptyParents(target, source);
        }
        journal = { ...journal, phase: "rolled_back", currentOperation: undefined };
        await persistJournal();
      } catch (rollbackCause) {
        throw new WorkspaceApplyError(
          "recovery_failed",
          "workspace apply and rollback both failed",
          {
            cause: new AggregateError([cause, rollbackCause]),
          },
        );
      }
      throw new WorkspaceApplyError("apply_failed", "workspace apply failed and was rolled back", {
        cause,
      });
    }
    await lease.assertOwned();
    journal = { ...journal, phase: "settling", currentOperation: undefined };
    await persistJournal();
    const nextRecord = await commitRuntimeBaseline(
      source,
      runtimeId,
      retained.baseline.digest,
      guestCurrent,
      roots,
    );
    journal = { ...journal, phase: "committed", currentOperation: undefined };
    await persistJournal();
    await rm(transaction, { recursive: true, force: true });
    return nextRecord;
  } finally {
    await lease.release();
  }
}

/** Roll back a journaled apply interrupted after its intent became durable. */
export async function recoverRuntimeWorkspaceApply(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  roots?: RootOptions,
): Promise<boolean> {
  const source = resolve(sourceWorkspaceRoot);
  const paths = workspaceStatePaths(source, roots);
  let raw: string;
  try {
    const info = await lstat(paths.runtimeJournalFile(runtimeId));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
      throw new WorkspaceApplyError(
        "recovery_failed",
        "runtime apply journal is unsafe or oversized",
      );
    }
    raw = await readFile(paths.runtimeJournalFile(runtimeId), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (cause instanceof WorkspaceApplyError) throw cause;
    throw new WorkspaceApplyError("recovery_failed", "runtime apply journal cannot be read", {
      cause,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new WorkspaceApplyError("recovery_failed", "runtime apply journal is invalid", { cause });
  }
  if (!isApplyJournal(value) || value.runtimeId !== runtimeId) {
    throw new WorkspaceApplyError("recovery_failed", "runtime apply journal identity is invalid");
  }
  if (value.phase === "committed" || value.phase === "rolled_back") return false;
  if (value.phase === "settling") {
    const retainedRoot = paths.runtimeWorkspaceDir(runtimeId);
    const nextBaseline = await scanRuntimeWorkspace(retainedRoot);
    if (nextBaseline.digest !== value.currentDigest) {
      throw new WorkspaceApplyError(
        "recovery_failed",
        "settling workspace no longer matches review",
      );
    }
    await commitRuntimeBaseline(source, runtimeId, value.baselineDigest, nextBaseline, roots);
    const committed: ApplyJournal = { ...value, phase: "committed", currentOperation: undefined };
    await writeFileDurable(paths.runtimeJournalFile(runtimeId), serialize(committed), {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    });
    await rm(paths.runtimeTransactionDir(runtimeId, value.changeSetId), {
      recursive: true,
      force: true,
    });
    return true;
  }
  await loadRuntimeWorkspace(source, runtimeId, roots);
  const transaction = paths.runtimeTransactionDir(runtimeId, value.changeSetId);
  const backup = join(transaction, "backup");
  const backupManifest = await scanRuntimeWorkspace(backup);
  const baseline = new Map(backupManifest.entries.map((entry) => [entry.path, entry]));
  const touched = new Set([
    ...value.applied,
    ...(value.currentOperation === undefined ? [] : [value.currentOperation]),
  ]);
  try {
    for (const operation of [...value.operations].reverse()) {
      if (!touched.has(operation.path)) continue;
      const target = join(source, operation.path);
      await rm(target, { recursive: true, force: true });
      const prior = baseline.get(operation.path);
      if (prior !== undefined) await materialize(join(backup, operation.path), target, prior);
      else await removeEmptyParents(target, source);
    }
    const recovered: ApplyJournal = {
      ...value,
      phase: "rolled_back",
      currentOperation: undefined,
    };
    await writeFileDurable(paths.runtimeJournalFile(runtimeId), serialize(recovered), {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    });
    await rm(transaction, { recursive: true, force: true });
    return true;
  } catch (cause) {
    throw new WorkspaceApplyError("recovery_failed", "runtime apply rollback could not complete", {
      cause,
    });
  }
}
