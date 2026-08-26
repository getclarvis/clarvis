import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  fsyncDir,
  fsyncDirSync,
  renameWithRetry,
  renameWithRetrySync,
  tmpPathFor,
  writeFileDurable,
  writeFileDurableSync,
} from "./atomic.ts";
import { DIR_MODE, FILE_MODE } from "./constants.ts";
import { pathsLogger, type PathsLogger } from "./diag.ts";

/** Immutable owner record published at a local lease path. */
export interface LocalLeaseRecord {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: number;
  /** Missing only on a legacy record written before host identity was recorded. */
  host?: string;
}

/** Timing and liveness seams shared by acquisition and orphan recovery. */
export interface LocalLeaseRecoveryOptions {
  /** A non-retired lock younger than this is always treated as live. */
  staleMs: number;
  /** Current wall clock, injectable for deterministic recovery tests. */
  now?: () => number;
  /** Current host identity. A legacy record without one is treated as local. */
  host?: string;
  /** Same-host process probe. Unknown/permission failures must be conservative. */
  processAlive?: (pid: number) => boolean;
  /** Test seam immediately before the observed lock is moved to quarantine. */
  beforeReclaim?: (path: string) => void;
  /** Test seam immediately after the canonical entry is moved to quarantine. */
  afterReclaimMove?: (path: string) => void;
  /**
   * Where to report reclamation and ownership loss; defaults to the
   * process-wide sink.
   *
   * @remarks This file decides **who owns a lock**, and every one of its
   *   failure paths resolves to a boolean the caller can only read as
   *   "contended". Stealing another process's lock on a stale-mtime and
   *   dead-pid judgement is the single densest blind spot here: if the
   *   judgement is wrong, two holders both believe they own the path and
   *   nothing anywhere says so.
   */
  logger?: PathsLogger;
}

/** Options for {@link acquireLocalLease}. */
export interface AcquireLocalLeaseOptions extends LocalLeaseRecoveryOptions {
  /** Total contention wait. Zero performs one acquisition attempt. */
  waitMs?: number;
  /** Delay between attempts while another live holder owns the path. */
  retryMs?: number;
  /** Automatic renewal interval. Zero or absent disables the heartbeat. */
  heartbeatMs?: number;
  /** Ownership-token source, injectable for deterministic tests. */
  token?: () => string;
  /** Test seam after closing the held inode and before detaching the path. */
  beforeRelease?: (path: string) => void | Promise<void>;
  /** Test seam immediately before a heartbeat updates the held inode. */
  beforeRenew?: (path: string) => void | Promise<void>;
  /** Test seam after publication and before the recovery-intent recheck. */
  afterPublish?: (path: string) => void | Promise<void>;
}

/** Options for the non-waiting synchronous lease variant. */
export interface AcquireLocalLeaseSyncOptions extends LocalLeaseRecoveryOptions {
  /** Ownership-token source, injectable for deterministic tests. */
  token?: () => string;
  /** Test seam after closing the held inode and before detaching the path. */
  beforeRelease?: (path: string) => void;
  /** Test seam after publication and before the recovery-intent recheck. */
  afterPublish?: (path: string) => void;
}

/** Raised when a holder attempts a fenced action after losing its lease. */
export class LocalLeaseLostError extends Error {
  constructor(readonly path: string) {
    super(`Local lease is no longer owned: ${path}`);
    this.name = "LocalLeaseLostError";
  }
}

/** A held local filesystem lease. */
export interface LocalLease {
  readonly path: string;
  readonly record: Readonly<LocalLeaseRecord>;
  /** Refresh the lease mtime through the held inode. False means ownership was lost. */
  renew(): Promise<boolean>;
  /** Verify token and inode ownership without changing the lease. */
  owned(): Promise<boolean>;
  /** Fence a protected effect after a possible asynchronous delay. */
  assertOwned(): Promise<void>;
  /** Stop heartbeats, close its handle, and remove only this holder's still-current lease. */
  release(): Promise<boolean>;
}

/** A synchronous local lease for callers whose public transaction is synchronous. */
export interface LocalLeaseSync {
  readonly path: string;
  readonly record: Readonly<LocalLeaseRecord>;
  /** Stop ownership and remove only this holder's still-current lease. */
  release(): boolean;
}

interface ObservedLease {
  info: Stats;
  record: LocalLeaseRecord | null;
}

interface RetiredLease {
  token: string;
  dev: number;
  ino: number;
}

interface RecoveryIntent {
  release(): Promise<void>;
}

interface RecoveryIntentSync {
  release(): void;
}

/**
 * A holder may retire while a transient filesystem error prevents it from
 * detaching the canonical entry. Remember only that exact inode in this
 * process so a later acquisition can finish the release without mistaking a
 * live PID for a still-active holder.
 */
const retiredLeases = new Set<string>();

function recoveryIntentDir(path: string): string {
  return `${path}.recovery`;
}

function recoveryIntentRecord(options: LocalLeaseRecoveryOptions): LocalLeaseRecord {
  return {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: (options.now ?? Date.now)(),
    host: options.host ?? systemHostname(),
  };
}

function retiredLeaseKey(path: string, retired: RetiredLease): string {
  return JSON.stringify([path, retired.token, retired.dev, retired.ino]);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

function parseLeaseRecord(text: string): LocalLeaseRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const record = value as Partial<LocalLeaseRecord> | null;
  if (
    record === null ||
    record.version !== 1 ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.acquiredAt !== "number" ||
    !Number.isFinite(record.acquiredAt) ||
    (record.host !== undefined && (typeof record.host !== "string" || record.host.length === 0))
  ) {
    return null;
  }
  return {
    version: 1,
    pid: record.pid,
    token: record.token,
    acquiredAt: record.acquiredAt,
    ...(record.host === undefined ? {} : { host: record.host }),
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservedLease(left: ObservedLease, right: ObservedLease): boolean {
  return (
    sameIdentity(left.info, right.info) &&
    (left.record?.token === undefined || left.record.token === right.record?.token)
  );
}

async function readRecord(path: string): Promise<LocalLeaseRecord | null> {
  try {
    return parseLeaseRecord(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function readRecordSync(path: string): LocalLeaseRecord | null {
  try {
    return parseLeaseRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best effort for a hidden temp or an already released canonical path.
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // Publication failed; closing must not replace its primary error.
  }
}

function closeQuietlySync(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // Publication failed; closing must not replace its primary error.
  }
}

function unlinkQuietlySync(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort for a hidden temp or an already released canonical path.
  }
}

async function observe(path: string): Promise<ObservedLease | null> {
  try {
    const info = await lstat(path);
    return { info, record: info.isFile() ? await readRecord(path) : null };
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

function observeSync(path: string): ObservedLease | null {
  try {
    const info = lstatSync(path);
    return { info, record: info.isFile() ? readRecordSync(path) : null };
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

function isRetired(path: string, observed: ObservedLease): boolean {
  if (observed.record === null) return false;
  return retiredLeases.has(
    retiredLeaseKey(path, {
      token: observed.record.token,
      dev: observed.info.dev,
      ino: observed.info.ino,
    }),
  );
}

function forgetRetired(path: string, observed: ObservedLease): void {
  if (observed.record === null) return;
  retiredLeases.delete(
    retiredLeaseKey(path, {
      token: observed.record.token,
      dev: observed.info.dev,
      ino: observed.info.ino,
    }),
  );
}

/** Why an observed lock may be taken from the holder that published it. */
type ReclaimReason = "retired" | "dead_pid" | "no_record";

function reclaimReason(
  path: string,
  observed: ObservedLease,
  options: LocalLeaseRecoveryOptions,
): ReclaimReason | undefined {
  const record = observed.record;
  const host = options.host ?? systemHostname();
  const localOwner = record === null || record.host === undefined || record.host === host;
  if (localOwner && isRetired(path, observed)) return "retired";
  const now = options.now ?? Date.now;
  if (now() - observed.info.mtimeMs <= Math.max(0, options.staleMs)) return undefined;
  if (record === null) return "no_record";
  // This primitive coordinates processes on one host only. A foreign host is
  // therefore unknowable, not dead; reclaiming it would accidentally pretend
  // to provide distributed-lock safety on a shared filesystem.
  if (!localOwner) return undefined;
  try {
    return (options.processAlive ?? processIsAlive)(record.pid) ? undefined : "dead_pid";
  } catch {
    return undefined;
  }
}

function reclaimable(
  path: string,
  observed: ObservedLease,
  options: LocalLeaseRecoveryOptions,
): boolean {
  return reclaimReason(path, observed, options) !== undefined;
}

/**
 * Emit one lease diagnostic without letting it decide anything.
 *
 * @param emit - the report to make.
 *
 * @remarks {@link PathsLogger} is a public interface any host implements, and
 * every report in this module is made from inside a `catch`, or immediately
 * after a point of no return — a lock already unlinked, a handle already
 * closed. A sink that threw there unwound through the recovery's own error
 * handling: a reclamation that had *succeeded* restored nothing, forgot nothing
 * and answered `false`, so the caller read "still contended" for a lock that no
 * longer existed. A diagnostic may be lost; it may never change an outcome.
 */
function reportQuietly(emit: () => void): void {
  try {
    emit();
  } catch {
    // See the remark above: losing the line is the lesser failure.
  }
}

/**
 * Report that this process took a lock away from the holder that published it.
 *
 * @param logger - where to report it.
 * @param path - the canonical lock path.
 * @param observed - the record and inode that were reclaimed.
 * @param reason - the judgement that authorized it.
 * @param options - the clock the age is measured against.
 *
 * @remarks `warn` rather than `debug`: the judgement is a heuristic over an
 * mtime and a PID probe, and when it is wrong the consequence is two holders
 * inside one critical section. Every field is a primitive; nothing here carries
 * a caller's content.
 */
function reportReclaimed(
  logger: PathsLogger,
  path: string,
  observed: ObservedLease,
  reason: ReclaimReason,
  options: LocalLeaseRecoveryOptions,
): void {
  reportQuietly(() => {
    logger.warn(
      {
        event: "paths.lease_reclaimed",
        path,
        prior_pid: observed.record?.pid ?? null,
        prior_host: observed.record?.host ?? null,
        age_ms: (options.now ?? Date.now)() - observed.info.mtimeMs,
        reason,
      },
      "took over an abandoned lock; the previous holder is assumed gone and is not told",
    );
  });
}

/** Where a holder discovered it no longer owns its lease. */
type LeaseLossPhase = "renew" | "release" | "stat";

/**
 * Report that a holder lost its lease.
 *
 * @param logger - where to report it.
 * @param path - the canonical lock path.
 * @param token - the holder's ownership token, which is what distinguishes it
 *   from the successor now holding the same path.
 * @param phase - where the loss was discovered.
 *
 * @remarks The holder's own signal is a `false` return, and its caller
 * typically treats that as "already released". A lost heartbeat means the
 * critical section this lease was fencing is no longer fenced.
 */
function reportLeaseLost(
  logger: PathsLogger,
  path: string,
  token: string,
  phase: LeaseLossPhase,
): void {
  reportQuietly(() => {
    logger.warn(
      { event: "paths.lease_lost", path, token, phase },
      "a lease holder lost its lock; whatever it was fencing is no longer fenced",
    );
  });
}

/** Which step of a reclamation gave the lock back to its holder. */
type ReclaimRefusal =
  "identity_changed" | "rename_failed" | "quarantine_mismatch" | "unlink_failed";

/**
 * Report that a reclamation aborted, and at which step.
 *
 * @param logger - where to report it.
 * @param path - the canonical lock path.
 * @param stage - the step that refused.
 *
 * @remarks All four abort paths return the same `false` a live, healthy lock
 * returns, so without the stage an operator cannot tell contention from a
 * filesystem that keeps refusing the recovery.
 */
function reportReclaimRefused(logger: PathsLogger, path: string, stage: ReclaimRefusal): void {
  reportQuietly(() => {
    logger.debug(
      { event: "paths.lease_reclaim_refused", path, stage },
      "a lease reclamation aborted and left the lock in place; the caller sees only contention",
    );
  });
}

async function createRecoveryIntent(
  path: string,
  options: LocalLeaseRecoveryOptions,
): Promise<RecoveryIntent> {
  const directory = recoveryIntentDir(path);
  const marker = join(directory, `intent-${randomUUID()}`);
  await writeFileDurable(marker, JSON.stringify(recoveryIntentRecord(options)));
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await unlinkQuietly(marker);
      await fsyncDir(directory);
    },
  };
}

function createRecoveryIntentSync(
  path: string,
  options: LocalLeaseRecoveryOptions,
): RecoveryIntentSync {
  const directory = recoveryIntentDir(path);
  const marker = join(directory, `intent-${randomUUID()}`);
  writeFileDurableSync(marker, JSON.stringify(recoveryIntentRecord(options)));
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      unlinkQuietlySync(marker);
      fsyncDirSync(directory);
    },
  };
}

async function hasActiveRecoveryIntent(
  path: string,
  options: LocalLeaseRecoveryOptions,
): Promise<boolean> {
  const directory = recoveryIntentDir(path);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
  let active = false;
  for (const name of names) {
    const marker = join(directory, name);
    const observed = await observe(marker);
    if (observed === null) continue;
    if (!reclaimable(marker, observed, options)) {
      active = true;
      continue;
    }
    await unlinkQuietly(marker);
  }
  return active;
}

function hasActiveRecoveryIntentSync(path: string, options: LocalLeaseRecoveryOptions): boolean {
  const directory = recoveryIntentDir(path);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
  let active = false;
  for (const name of names) {
    const marker = join(directory, name);
    const observed = observeSync(marker);
    if (observed === null) continue;
    if (!reclaimable(marker, observed, options)) {
      active = true;
      continue;
    }
    unlinkQuietlySync(marker);
  }
  return active;
}

async function abandonPublishedLease(lease: LocalLease): Promise<void> {
  try {
    await lease.release();
  } catch {
    // The publication/recheck error remains primary. release() closes the held
    // descriptor and retires its exact identity before any fallible detach.
  }
}

function abandonPublishedLeaseSync(lease: LocalLeaseSync): void {
  try {
    lease.release();
  } catch {
    // See the asynchronous counterpart.
  }
}

async function restoreQuarantine(quarantine: string, path: string): Promise<void> {
  try {
    await link(quarantine, path);
    await unlink(quarantine);
  } catch {
    // Never overwrite a successor. A leftover temp is hidden by TMP_PREFIX and
    // is safer than deleting bytes whose ownership changed during recovery.
  }
}

function restoreQuarantineSync(quarantine: string, path: string): void {
  try {
    linkSync(quarantine, path);
    unlinkSync(quarantine);
  } catch {
    // See the async counterpart: preserving a quarantine is the safe fallback.
  }
}

/**
 * Reclaim one expired local lease after checking its process and observed inode.
 *
 * Empty or partial legacy lockfiles are deliberately recoverable, but only
 * after the same stale grace as a valid record. The move to a unique quarantine
 * makes two reclaimers race on one directory entry; the winner validates that
 * it moved the inode/token it inspected before deleting it.
 */
export async function reclaimLocalLease(
  path: string,
  options: LocalLeaseRecoveryOptions,
): Promise<boolean> {
  const logger = options.logger ?? pathsLogger();
  const observed = await observe(path);
  if (observed === null) return true;
  if (!reclaimable(path, observed, options)) return false;
  const intent = await createRecoveryIntent(path, options);
  try {
    options.beforeReclaim?.(path);
    const current = await observe(path);
    if (current === null) return true;
    const reason = reclaimReason(path, current, options);
    if (!sameObservedLease(observed, current) || reason === undefined) {
      reportReclaimRefused(logger, path, "identity_changed");
      return false;
    }

    const quarantine = tmpPathFor(path);
    try {
      await renameWithRetry(path, quarantine, { logger });
      options.afterReclaimMove?.(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return true;
      reportReclaimRefused(logger, path, "rename_failed");
      return false;
    }

    let moved: ObservedLease | null;
    try {
      moved = await observe(quarantine);
    } catch {
      moved = null;
    }
    if (moved === null || !sameObservedLease(current, moved)) {
      await restoreQuarantine(quarantine, path);
      reportReclaimRefused(logger, path, "quarantine_mismatch");
      return false;
    }

    try {
      await unlink(quarantine);
      await fsyncDir(dirname(path));
    } catch (error) {
      if (errno(error) === "ENOENT") return true;
      await restoreQuarantine(quarantine, path);
      reportReclaimRefused(logger, path, "unlink_failed");
      return false;
    }
    forgetRetired(path, current);
    reportReclaimed(logger, path, current, reason, options);
    return true;
  } finally {
    await intent.release();
  }
}

/** Synchronous orphan recovery for synchronous retention/cleanup paths. */
export function reclaimLocalLeaseSync(path: string, options: LocalLeaseRecoveryOptions): boolean {
  const logger = options.logger ?? pathsLogger();
  const observed = observeSync(path);
  if (observed === null) return true;
  if (!reclaimable(path, observed, options)) return false;
  const intent = createRecoveryIntentSync(path, options);
  try {
    options.beforeReclaim?.(path);
    const current = observeSync(path);
    if (current === null) return true;
    const reason = reclaimReason(path, current, options);
    if (!sameObservedLease(observed, current) || reason === undefined) {
      reportReclaimRefused(logger, path, "identity_changed");
      return false;
    }

    const quarantine = tmpPathFor(path);
    try {
      renameWithRetrySync(path, quarantine, { logger });
      options.afterReclaimMove?.(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return true;
      reportReclaimRefused(logger, path, "rename_failed");
      return false;
    }

    let moved: ObservedLease | null;
    try {
      moved = observeSync(quarantine);
    } catch {
      moved = null;
    }
    if (moved === null || !sameObservedLease(current, moved)) {
      restoreQuarantineSync(quarantine, path);
      reportReclaimRefused(logger, path, "quarantine_mismatch");
      return false;
    }

    try {
      unlinkSync(quarantine);
      fsyncDirSync(dirname(path));
    } catch (error) {
      if (errno(error) === "ENOENT") return true;
      restoreQuarantineSync(quarantine, path);
      reportReclaimRefused(logger, path, "unlink_failed");
      return false;
    }
    forgetRetired(path, current);
    reportReclaimed(logger, path, current, reason, options);
    return true;
  } finally {
    intent.release();
  }
}

async function handleOwns(handle: FileHandle, path: string, token: string): Promise<boolean> {
  try {
    const [held, current, record] = await Promise.all([
      handle.stat(),
      lstat(path),
      readRecord(path),
    ]);
    return current.isFile() && sameIdentity(held, current) && record?.token === token;
  } catch {
    return false;
  }
}

function descriptorOwns(descriptor: number, path: string, token: string): boolean {
  try {
    const held = fstatSync(descriptor);
    const current = lstatSync(path);
    const record = readRecordSync(path);
    return current.isFile() && sameIdentity(held, current) && record?.token === token;
  } catch {
    return false;
  }
}

function createLease(
  path: string,
  handle: FileHandle,
  record: LocalLeaseRecord,
  options: AcquireLocalLeaseOptions,
): LocalLease {
  let released = false;
  let lost = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let heartbeatRequested = false;
  let heartbeatStopped = false;
  const logger = options.logger ?? pathsLogger();

  const owned = async (): Promise<boolean> => {
    if (released || lost) return false;
    const current = await handleOwns(handle, path, record.token);
    if (!current) lost = true;
    return current;
  };

  const renew = async (): Promise<boolean> => {
    if (!(await owned())) return false;
    try {
      await options.beforeRenew?.(path);
      const stamp = new Date((options.now ?? Date.now)());
      await handle.utimes(stamp, stamp);
    } catch {
      lost = true;
      reportLeaseLost(logger, path, record.token, "renew");
      return false;
    }
    return owned();
  };

  const heartbeatMs = Math.max(0, options.heartbeatMs ?? 0);
  if (heartbeatMs > 0) {
    const requestHeartbeat = (): void => {
      if (heartbeatStopped) return;
      if (heartbeatInFlight !== undefined) {
        heartbeatRequested = true;
        return;
      }
      heartbeatInFlight = (async () => {
        do {
          heartbeatRequested = false;
          await renew();
        } while (heartbeatRequested && !heartbeatStopped);
      })().finally(() => {
        heartbeatInFlight = undefined;
      });
    };
    heartbeat = setInterval(() => {
      requestHeartbeat();
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    path,
    record: Object.freeze({ ...record }),
    renew,
    owned,
    async assertOwned(): Promise<void> {
      if (!(await owned())) throw new LocalLeaseLostError(path);
    },
    async release(): Promise<boolean> {
      if (released) return false;
      heartbeatStopped = true;
      heartbeatRequested = false;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await heartbeatInFlight;
      const current = await owned();
      let heldIdentity: Stats | undefined;
      let cleanlyReleased = false;
      try {
        heldIdentity = await handle.stat();
      } catch {
        lost = true;
        reportLeaseLost(logger, path, record.token, "stat");
      }
      released = true;
      try {
        try {
          await handle.close();
        } catch {
          lost = true;
          reportLeaseLost(logger, path, record.token, "release");
        }
        if (!current || lost || heldIdentity === undefined) return false;

        await options.beforeRelease?.(path);
        const quarantine = tmpPathFor(path);
        try {
          // Detach the directory entry first, then inspect the inode that was
          // actually moved. This makes the check-and-remove one atomic namespace
          // transition: an ABA successor is restored, never unlinked.
          await renameWithRetry(path, quarantine);
        } catch {
          return false;
        }
        const moved = await observe(quarantine);
        if (
          moved === null ||
          !sameIdentity(moved.info, heldIdentity) ||
          moved.record?.token !== record.token
        ) {
          await restoreQuarantine(quarantine, path);
          return false;
        }
        try {
          await unlink(quarantine);
          await fsyncDir(dirname(path));
          cleanlyReleased = true;
          return true;
        } catch (error) {
          if (errno(error) === "ENOENT") return false;
          await restoreQuarantine(quarantine, path);
          return false;
        }
      } finally {
        if (heldIdentity !== undefined) {
          const retiredKey = retiredLeaseKey(path, {
            token: record.token,
            dev: heldIdentity.dev,
            ino: heldIdentity.ino,
          });
          if (cleanlyReleased) retiredLeases.delete(retiredKey);
          else retiredLeases.add(retiredKey);
        }
      }
    },
  };
}

function createLeaseSync(
  path: string,
  descriptor: number,
  record: LocalLeaseRecord,
  options: AcquireLocalLeaseSyncOptions,
): LocalLeaseSync {
  let released = false;

  return {
    path,
    record: Object.freeze({ ...record }),
    release(): boolean {
      if (released) return false;
      const current = descriptorOwns(descriptor, path, record.token);
      let heldIdentity: Stats | undefined;
      try {
        heldIdentity = fstatSync(descriptor);
      } catch {
        // A lost descriptor cannot authorize namespace cleanup.
      }
      released = true;
      let cleanlyReleased = false;
      try {
        try {
          closeSync(descriptor);
        } catch {
          return false;
        }
        if (!current || heldIdentity === undefined) return false;

        options.beforeRelease?.(path);
        const quarantine = tmpPathFor(path);
        try {
          renameWithRetrySync(path, quarantine);
        } catch {
          return false;
        }
        const moved = observeSync(quarantine);
        if (
          moved === null ||
          !sameIdentity(moved.info, heldIdentity) ||
          moved.record?.token !== record.token
        ) {
          restoreQuarantineSync(quarantine, path);
          return false;
        }
        try {
          unlinkSync(quarantine);
          fsyncDirSync(dirname(path));
          cleanlyReleased = true;
          return true;
        } catch (error) {
          if (errno(error) === "ENOENT") return false;
          restoreQuarantineSync(quarantine, path);
          return false;
        }
      } finally {
        if (heldIdentity !== undefined) {
          const retiredKey = retiredLeaseKey(path, {
            token: record.token,
            dev: heldIdentity.dev,
            ino: heldIdentity.ino,
          });
          if (cleanlyReleased) retiredLeases.delete(retiredKey);
          else retiredLeases.add(retiredKey);
        }
      }
    },
  };
}

async function tryPublish(
  path: string,
  options: AcquireLocalLeaseOptions,
): Promise<LocalLease | null> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: DIR_MODE });
  const temp = tmpPathFor(path);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, FILE_MODE);
    const record: LocalLeaseRecord = {
      version: 1,
      pid: process.pid,
      token: (options.token ?? randomUUID)(),
      acquiredAt: (options.now ?? Date.now)(),
      host: options.host ?? systemHostname(),
    };
    await handle.writeFile(JSON.stringify(record));
    await handle.chmod(FILE_MODE);
    await handle.sync();
    if (await hasActiveRecoveryIntent(path, options)) return null;
    try {
      // The canonical path appears in one step and already refers to complete,
      // fsync'd bytes. A crash can orphan the temp or the valid lease, never a
      // canonical zero-length/half-written record.
      await link(temp, path);
    } catch (error) {
      if (errno(error) === "EEXIST") return null;
      throw error;
    }
    published = true;
    await unlinkQuietly(temp);
    await fsyncDir(parent);
    const lease = createLease(path, handle, record, options);
    try {
      await options.afterPublish?.(path);
      if (await hasActiveRecoveryIntent(path, options)) {
        await abandonPublishedLease(lease);
        return null;
      }
      return lease;
    } catch (error) {
      await abandonPublishedLease(lease);
      throw error;
    }
  } finally {
    if (!published) {
      await closeQuietly(handle);
      await unlinkQuietly(temp);
    }
  }
}

function tryPublishSync(
  path: string,
  options: AcquireLocalLeaseSyncOptions,
): LocalLeaseSync | null {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  const temp = tmpPathFor(path);
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, FILE_MODE);
    const record: LocalLeaseRecord = {
      version: 1,
      pid: process.pid,
      token: (options.token ?? randomUUID)(),
      acquiredAt: (options.now ?? Date.now)(),
      host: options.host ?? systemHostname(),
    };
    writeFileSync(descriptor, JSON.stringify(record));
    fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
    if (hasActiveRecoveryIntentSync(path, options)) return null;
    try {
      linkSync(temp, path);
    } catch (error) {
      if (errno(error) === "EEXIST") return null;
      throw error;
    }
    published = true;
    unlinkQuietlySync(temp);
    fsyncDirSync(parent);
    const lease = createLeaseSync(path, descriptor, record, options);
    try {
      options.afterPublish?.(path);
      if (hasActiveRecoveryIntentSync(path, options)) {
        abandonPublishedLeaseSync(lease);
        return null;
      }
      return lease;
    } catch (error) {
      abandonPublishedLeaseSync(lease);
      throw error;
    }
  } finally {
    if (!published) {
      closeQuietlySync(descriptor);
      unlinkQuietlySync(temp);
    }
  }
}

/**
 * Acquire a process-local filesystem lease, or return `null` after contention.
 *
 * The lock path is an immutable, complete ownership record. Heartbeats update
 * its inode mtime rather than rewriting JSON, so a power loss cannot turn a
 * once-valid current lease into a partial record.
 */
export async function acquireLocalLease(
  path: string,
  options: AcquireLocalLeaseOptions,
): Promise<LocalLease | null> {
  const logger = options.logger ?? pathsLogger();
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const retryMs = Math.max(1, options.retryMs ?? 25);
  const attempts = Math.max(1, Math.ceil(waitMs / retryMs) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lease = await tryPublish(path, options);
    if (lease !== null) return lease;
    if (await reclaimLocalLease(path, options)) {
      const recovered = await tryPublish(path, options);
      if (recovered !== null) return recovered;
    }
    if (attempt + 1 >= attempts) return null;
    logger.debug(
      { event: "paths.lease_contended", path, attempt, waited_ms: attempt * retryMs },
      "another live holder owns this lock; waiting before another attempt",
    );
    await delay(retryMs);
  }
  return null;
}

/**
 * Acquire the same crash-safe local lease synchronously, without waiting.
 *
 * This exists for synchronous persistence APIs that cannot yield while holding
 * their transaction. Contention returns `null`; stale/dead-owner recovery uses
 * the identical local-host policy as {@link acquireLocalLease}.
 */
export function acquireLocalLeaseSync(
  path: string,
  options: AcquireLocalLeaseSyncOptions,
): LocalLeaseSync | null {
  const lease = tryPublishSync(path, options);
  if (lease !== null) return lease;
  if (!reclaimLocalLeaseSync(path, options)) return null;
  return tryPublishSync(path, options);
}
