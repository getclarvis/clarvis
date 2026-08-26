import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DIR_MODE, FILE_MODE, TMP_PREFIX } from "./constants.ts";
import { announceOnce, pathsLogger, type PathsLogger } from "./diag.ts";

/**
 * Backoff schedule for a contended `rename`: four retries over roughly 185 ms.
 *
 * @remarks Exported so a caller that wraps its own `rename` can keep the same
 * shape rather than inventing a second schedule.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100];

/** The errnos a Windows file scanner produces transiently while holding a handle. */
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** In-process serial number, so two writers of one path cannot share a temp name. */
let tmpCounter = 0;

/**
 * Build the sibling temp path an atomic write of `target` renames into place.
 *
 * @param target - the absolute path the write will end up at.
 * @returns a path in `target`'s own directory, prefixed with {@link TMP_PREFIX}.
 *
 * @remarks
 * A sibling rather than a `tmpdir()` file because `rename` is only atomic within
 * one filesystem. The name answers both collision hazards at once, which is the
 * property the copies this replaces had already lost: the pid separates two
 * processes, the counter separates two writers *inside* one process, and the
 * UUID makes the whole name collision-free even across a fork that inherits the
 * counter. `@clarvis/server`'s signing key was written to a bare `<file>.tmp`,
 * so two boots racing the same key file collided on one temp path.
 *
 * Paired with {@link isTmpFile}: a sweeper must never re-spell the convention.
 */
export function tmpPathFor(target: string): string {
  tmpCounter += 1;
  return join(dirname(target), `${TMP_PREFIX}${process.pid}-${tmpCounter}-${randomUUID()}`);
}

/**
 * Test whether a bare filename is an atomic-write temp file.
 *
 * @param name - a filename, without directory, as `readdir` yields it.
 * @returns `true` when a sweeper should treat it as an orphan candidate.
 *
 * @remarks
 * Paired with {@link tmpPathFor} for the reason `isMonitorSidecar` is paired
 * with its builder. `@clarvis/trace` carried a private `` /\.json\.tmp-/ ``
 * matching a shape six other modules built independently — exactly the drift
 * that once left every shell spill uncollected. Because the convention is a
 * prefix, `TMP_GLOB` already ignores these files, so an orphan is invisible to
 * `grep`/`glob` and to git without any further rule.
 */
export function isTmpFile(name: string): boolean {
  return name.startsWith(TMP_PREFIX);
}

/**
 * The errno of a failed `rename`, when it is one a Windows handle-holder causes
 * transiently.
 *
 * @param error - the thrown value.
 * @returns `EPERM`, `EACCES` or `EBUSY`; `undefined` for anything else.
 * @remarks It returns the code rather than a boolean so the retry can report
 *   *which* transient failure it is waiting out without reading the error a
 *   second time.
 */
function retryableRenameCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && RETRYABLE_RENAME_CODES.has(code) ? code : undefined;
}

/**
 * The errno of an arbitrary thrown value, for a diagnostic field.
 *
 * @param error - the thrown value.
 * @returns its `code`, or `"unknown"` when it carries none.
 */
function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
}

/** Test seams for {@link renameWithRetry}. */
export interface RenameRetryOptions {
  /** The rename to perform; defaults to `node:fs/promises`'s. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Backoff schedule in milliseconds; defaults to {@link RENAME_RETRY_DELAYS_MS}. */
  delays?: readonly number[];
  /** Host platform; injectable so the Windows path is testable from a POSIX host. */
  platform?: NodeJS.Platform;
  /** Where to report a retried rename; defaults to discarding it. */
  logger?: PathsLogger;
}

/** Test seams for {@link renameWithRetrySync}. */
export interface RenameRetrySyncOptions {
  /** The rename to perform; defaults to `node:fs`'s. */
  rename?: (from: string, to: string) => void;
  /** Backoff schedule in milliseconds; defaults to {@link RENAME_RETRY_DELAYS_MS}. */
  delays?: readonly number[];
  /** Host platform; injectable so the Windows path is testable from a POSIX host. */
  platform?: NodeJS.Platform;
  /** Where to report a retried rename; defaults to discarding it. */
  logger?: PathsLogger;
}

/**
 * `rename`, with a bounded retry on the transient failures Windows produces.
 *
 * @param from - the source path.
 * @param to - the destination path, which may already exist.
 * @param opts - test seams; see {@link RenameRetryOptions}.
 * @throws whatever `rename` threw, once the retries are exhausted or the error
 *   is not retryable.
 *
 * @remarks
 * **The deliberate Windows decision.** Renaming *over an existing file* is a
 * real hazard there and not on POSIX: an antivirus, the search indexer or an
 * editor momentarily holding the destination makes `MoveFileEx` fail with
 * `EPERM`/`EACCES`/`EBUSY` for a few tens of milliseconds. Retrying is the fix,
 * but only there — POSIX has no such transient failure, and an `EPERM` from
 * POSIX `rename` is a sticky-bit denial that will never clear, so the retry is
 * gated on the platform as well as on the errno and a genuine Linux permission
 * failure is not delayed by 185 ms. Every other errno (`ENOENT`, `EXDEV`,
 * `ENOTEMPTY`, …) propagates on the first attempt on both platforms. The
 * schedule carries one wait per retry, and the attempt after the last wait
 * propagates whatever it fails with — five attempts in all by default.
 *
 * Two residual Windows exposures this cannot close, documented rather than
 * papered over: `MoveFileEx` refuses to replace a destination carrying the
 * read-only attribute (a permanent failure no retry helps, and clearing the
 * attribute would be a behaviour change rather than a portability fix), and a
 * holder that keeps the destination open for longer than the schedule still
 * fails the write.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: RenameRetryOptions = {},
): Promise<void> {
  const move = opts.rename ?? rename;
  const delays = opts.delays ?? RENAME_RETRY_DELAYS_MS;
  const retryable = (opts.platform ?? process.platform) === "win32";
  const logger = opts.logger ?? pathsLogger();
  for (const [attempt, backoff] of delays.entries()) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = retryable ? retryableRenameCode(error) : undefined;
      if (code === undefined) throw error;
      logger.debug(
        { event: "paths.rename_retried", to, attempt, code, backoff_ms: backoff },
        "a handle holder blocked a rename over an existing file; retrying after a short backoff",
      );
      await new Promise((settle) => setTimeout(settle, backoff));
    }
  }
  await move(from, to);
}

/**
 * Block the calling thread for `ms`.
 *
 * @param ms - how long to wait.
 *
 * @remarks The synchronous counterpart of the `setTimeout` the async retry
 * awaits. It genuinely stops the thread, which is why the schedule it serves is
 * measured in tens of milliseconds and bounded at four attempts.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Synchronous {@link renameWithRetry}, for the config and session writers that
 * cannot be asynchronous.
 *
 * @param from - the source path.
 * @param to - the destination path, which may already exist.
 * @param opts - test seams; see {@link RenameRetrySyncOptions}.
 * @throws whatever `rename` threw, once the retries are exhausted or the error
 *   is not retryable.
 *
 * @remarks Identical policy to {@link renameWithRetry}, including the platform
 * gate; the wait blocks the thread rather than yielding, so it costs a stalled
 * process on Windows contention and nothing at all anywhere else.
 */
export function renameWithRetrySync(
  from: string,
  to: string,
  opts: RenameRetrySyncOptions = {},
): void {
  const move = opts.rename ?? renameSync;
  const delays = opts.delays ?? RENAME_RETRY_DELAYS_MS;
  const retryable = (opts.platform ?? process.platform) === "win32";
  const logger = opts.logger ?? pathsLogger();
  for (const [attempt, backoff] of delays.entries()) {
    try {
      move(from, to);
      return;
    } catch (error) {
      const code = retryable ? retryableRenameCode(error) : undefined;
      if (code === undefined) throw error;
      logger.debug(
        { event: "paths.rename_retried", to, attempt, code, backoff_ms: backoff },
        "a handle holder blocked a rename over an existing file; retrying after a short backoff",
      );
      sleepSync(backoff);
    }
  }
  move(from, to);
}

/**
 * Report, once per process per errno, that this filesystem will not sync a
 * directory handle.
 *
 * @param dir - the directory whose sync was refused.
 * @param error - the refusal.
 *
 * @remarks The one diagnostic in this package an operator cannot obtain any
 * other way. {@link fsyncDir}'s catch treats the refusal as a no-op, so
 * {@link writeFileDurable} silently degrades to {@link writeFileAtomic} — and
 * every crash-recovery guarantee in the product rests on that `fsync`: the plan
 * lockfiles, the trace journal, `auth.json`, the signing key. Rate-limited to
 * one line per errno because a filesystem does not change its mind, and a
 * durable write happens hundreds of times per run.
 */
function reportUnsyncableDir(dir: string, error: unknown): void {
  const code = errnoOf(error);
  if (!announceOnce(`paths.fsync_dir_unsupported\u0000${code}`)) return;
  pathsLogger().debug(
    { event: "paths.fsync_dir_unsupported", dir, code },
    "this filesystem will not sync a directory handle; a durable write is only as durable as it",
  );
}

/**
 * Best-effort `fsync` of a directory, durably persisting a rename of one of its
 * entries.
 *
 * @param dir - the directory to flush.
 *
 * @remarks Never throws. Windows will not open or sync a directory handle at
 * all, and several filesystems reject the `fsync`; treating either as a no-op is
 * what keeps {@link writeFileDurable} portable. On the platforms that do support
 * it this is the step that makes the rename itself survive a power loss — the
 * payload `fsync` alone only guarantees the *bytes*.
 */
export async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    reportUnsyncableDir(dir, error);
  } finally {
    await handle?.close();
  }
}

/**
 * Synchronous {@link fsyncDir}.
 *
 * @param dir - the directory to flush.
 */
export function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    reportUnsyncableDir(dir, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Permission overrides for one atomic write. */
export interface AtomicWriteOptions {
  /** Permission bits for the written file; defaults to {@link FILE_MODE}. */
  mode?: number;
  /** Permission bits for any parent directory created; defaults to {@link DIR_MODE}. */
  dirMode?: number;
  /**
   * Where to report a staging failure; defaults to the process-wide sink.
   *
   * @remarks A failed write already reaches the caller as a thrown error. What
   *   does not is whether the temp file survived it — see
   *   `paths.atomic_staging_failed`.
   */
  logger?: PathsLogger;
}

/**
 * Report a failed atomic write, and whether it leaked its temp file.
 *
 * @param logger - where to report it.
 * @param file - the destination the write was staging for.
 * @param error - the failure that aborted the write.
 * @param durable - whether the caller asked for a durable write.
 * @param tmpRemoved - whether the staged temp file was cleaned up.
 *
 * @remarks The thrown `error` already reaches the caller; `tmp_removed` does
 * not, and that is the half worth a channel. A cleanup that fails leaves a
 * `.clarvis-tmp-*` orphan, and because the convention is a prefix that
 * `TMP_GLOB` already hides, that orphan is invisible to `grep`, to `glob` and
 * to git — so nothing else in the product would ever mention it.
 */
function reportStagingFailure(
  logger: PathsLogger,
  file: string,
  error: unknown,
  durable: boolean,
  tmpRemoved: boolean,
): void {
  logger.warn(
    {
      event: "paths.atomic_staging_failed",
      file,
      code: errnoOf(error),
      durable,
      tmp_removed: tmpRemoved,
    },
    "an atomic write failed while staging; the error is thrown to the caller",
  );
}

/**
 * The body of all four public writers: stage a temp file, then rename it over
 * the target.
 *
 * @param file - the destination path.
 * @param data - the bytes or text to persist.
 * @param opts - permission overrides.
 * @param durable - whether to `fsync` the payload before the rename and the
 *   directory after it.
 *
 * @remarks The `chmod` after the write is not redundant with `open`'s mode
 * argument: the creation mode is masked by the process umask, so a host running
 * under an unusual one would otherwise get a file Clarvis did not ask for.
 *
 * Every step from `open` onward is staged inside one `try`, so *any* failure
 * removes the temp — not only a failed rename. Scoping the cleanup to the
 * rename leaked the temp whenever the write itself failed, which is exactly
 * when failure is likeliest and repeated: `ENOSPC`, `EIO` and `EDQUOT` all
 * abort in `writeFile` or in the durable `sync()`. Every settings, secrets,
 * session and signing-key write routes through here, and only the trace
 * directory has a sweeper, so those orphans would accumulate where nothing
 * collects them — once per retry, in the disk-full case that produced them.
 * A failure of the *removal* is swallowed so the original error is what the
 * caller sees.
 */
async function writeStaged(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions,
  durable: boolean,
): Promise<void> {
  const dir = dirname(file);
  const mode = opts.mode ?? FILE_MODE;
  const logger = opts.logger ?? pathsLogger();
  await mkdir(dir, { recursive: true, mode: opts.dirMode ?? DIR_MODE });
  const tmp = tmpPathFor(file);
  try {
    const handle = await open(tmp, "wx", mode);
    try {
      await handle.writeFile(data);
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, mode);
    await renameWithRetry(tmp, file, { logger });
  } catch (error) {
    let tmpRemoved = true;
    try {
      await rm(tmp, { force: true });
    } catch {
      tmpRemoved = false;
    }
    reportStagingFailure(logger, file, error, durable, tmpRemoved);
    throw error;
  }
  if (durable) await fsyncDir(dir);
}

/** Synchronous {@link writeStaged}. */
function writeStagedSync(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions,
  durable: boolean,
): void {
  const dir = dirname(file);
  const mode = opts.mode ?? FILE_MODE;
  const logger = opts.logger ?? pathsLogger();
  mkdirSync(dir, { recursive: true, mode: opts.dirMode ?? DIR_MODE });
  const tmp = tmpPathFor(file);
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeFileSync(fd, data);
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameWithRetrySync(tmp, file, { logger });
  } catch (error) {
    let tmpRemoved = true;
    try {
      rmSync(tmp, { force: true });
    } catch {
      tmpRemoved = false;
    }
    reportStagingFailure(logger, file, error, durable, tmpRemoved);
    throw error;
  }
  if (durable) fsyncDirSync(dir);
}

/**
 * Replace `file` with `data` atomically: write a sibling temp file, then rename
 * it into place.
 *
 * @param file - the destination path; its parent directories are created.
 * @param data - the text or bytes to persist.
 * @param opts - permission overrides; see {@link AtomicWriteOptions}.
 *
 * @remarks A concurrent reader sees either the old file or the complete new one,
 * never a torn write. Parent directories are created {@link DIR_MODE} and the
 * file is written {@link FILE_MODE} — this package owns that policy, so a caller
 * overriding `mode` is stating a deliberate exception. An existing target's
 * permission bits are **not** preserved: the point of routing every writer
 * through here is that a Clarvis-owned file has one posture.
 *
 * Use {@link writeFileDurable} instead when the file is a commit point whose
 * loss to a power failure would break a recovery guarantee; this variant leaves
 * durability to the filesystem.
 */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  return writeStaged(file, data, opts, false);
}

/**
 * Synchronous {@link writeFileAtomic}.
 *
 * @param file - the destination path; its parent directories are created.
 * @param data - the text or bytes to persist.
 * @param opts - permission overrides; see {@link AtomicWriteOptions}.
 */
export function writeFileAtomicSync(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): void {
  writeStagedSync(file, data, opts, false);
}

/**
 * Write a file that is a commit point, durably.
 *
 * @param file - the destination path; its parent directories are created.
 * @param data - the text or bytes to persist.
 * @param opts - permission overrides; see {@link AtomicWriteOptions}.
 *
 * @remarks Adds an `fsync` of the payload before the rename and a
 * {@link fsyncDir} after it. `rename` is atomic but not *durable*: after a power
 * loss the kernel may have reordered it ahead of the data it publishes, leaving
 * a journal entry that points at bytes which never reached the disk — and a
 * recovery matrix reasoning over such a journal would be theatre. That is why
 * this is a separate function rather than a flag folded into
 * {@link writeFileAtomic}: the two make different promises, and collapsing them
 * would either cost every ordinary write two `fsync`s or quietly downgrade the
 * writes that back a crash-recovery guarantee.
 */
export function writeFileDurable(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  return writeStaged(file, data, opts, true);
}

/**
 * Synchronous {@link writeFileDurable}.
 *
 * @param file - the destination path; its parent directories are created.
 * @param data - the text or bytes to persist.
 * @param opts - permission overrides; see {@link AtomicWriteOptions}.
 */
export function writeFileDurableSync(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): void {
  writeStagedSync(file, data, opts, true);
}
