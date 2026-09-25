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
 * counter. A bare `<file>.tmp` would make two concurrent writers collide.
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
 * Paired with {@link tmpPathFor} so a collector cannot drift from its builder.
 * `@clarvis/trace` once carried a private `` /\.json\.tmp-/ `` matching a
 * shape six other modules built independently. Because the convention is a
 * prefix, `TMP_GLOB` identifies orphaned files for cleanup.
 */
export function isTmpFile(name: string): boolean {
  return name.startsWith(TMP_PREFIX);
}

/** The errno of an arbitrary thrown value, for a diagnostic field. */
function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
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
 * @remarks Never throws. Some filesystems reject the `fsync`; treating this as
 * a no-op keeps {@link writeFileDurable} usable. On filesystems that support
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
 * `TMP_GLOB` identifies, housekeeping can find and remove it.
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
    await rename(tmp, file);
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
    renameSync(tmp, file);
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
