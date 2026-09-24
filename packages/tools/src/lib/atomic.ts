import { constants, promises as fs } from "node:fs";
import { bestEffort } from "./tasks.ts";
import path from "node:path";
import { TMP_GLOB, fsyncDir, renameWithRetry, tmpPathFor, writeFileDurable } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import type { ResolvedFilesystemPolicy } from "../sandbox.ts";

const locks = new Map<string, Promise<unknown>>();

/**
 * Options {@link fs.rm} takes to survive the same contention, documented for
 * exactly this case.
 */
export const RM_RETRY = { maxRetries: 4, retryDelay: 25 } as const;

/**
 * Bind the shared rename policy to this module's filesystem seam. Keeping the
 * function lookup live lets rollback tests inject a failing rename without
 * duplicating `@clarvis/paths`' retry algorithm or its platform matrix.
 */
function renameForTools(from: string, to: string): Promise<void> {
  return renameWithRetry(from, to, { rename: fs.rename });
}

/**
 * Serialize `fn` against every other call for the same `absPath`, so concurrent
 * read-modify-write on one file runs one at a time in call order.
 *
 * @param absPath - the absolute path used as the lock key; unrelated paths never
 *   contend.
 * @param fn - the critical section to run once the prior holder settles.
 * @returns whatever `fn` resolves to (or rejects with).
 * @remarks The next holder runs after the previous one settles whether it
 *   resolved or rejected, so one failed section never wedges the queue. The map
 *   entry is deleted once the last waiter drains, so an idle path holds no state.
 */
export function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(absPath) ?? Promise.resolve();

  const next = prev.then(fn, fn);

  const tail = next
    .catch(() => undefined)
    .finally(() => {
      if (locks.get(absPath) === tail) locks.delete(absPath);
    });
  locks.set(absPath, tail);
  return next;
}

/**
 * Hold {@link withFileLock} on several paths at once before running `fn`.
 *
 * @param paths - the paths to lock; duplicates are collapsed.
 * @param fn - the critical section to run while all locks are held.
 * @returns whatever `fn` resolves to (or rejects with).
 * @remarks Paths are locked in a fixed sorted order so two callers requesting an
 *   overlapping set can never deadlock by acquiring them in opposite orders.
 */
export function withFileLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(paths)].sort();
  return sorted.reduceRight<() => Promise<T>>((acc, p) => () => withFileLock(p, acc), fn)();
}

/** Host review of a fully prepared batch before staging or changing any target. */
export type MutationReview = ((
  operations: readonly FileOp[],
  commit: () => Promise<void>,
) => Promise<void>) & {
  /** Host-owned commit of exclusively classified configuration paths after review. */
  readonly commitClassified?: (
    operations: readonly FileOp[],
    policy: ResolvedFilesystemPolicy,
  ) => Promise<void>;
};

interface Staged {
  tmp: string;
  createdDir: string | undefined;
}

async function stage(
  target: string,
  content: string,
  modes?: { mode: number; dirMode: number },
): Promise<Staged> {
  const dir = path.dirname(target);
  const createdDir = await fs.mkdir(dir, {
    recursive: true,
    ...(modes === undefined ? {} : { mode: modes.dirMode }),
  });
  const tmp = tmpPathFor(target);
  const fh = await fs.open(tmp, "wx", modes?.mode);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { tmp, createdDir };
}

async function removeCreatedDirs(dirs: (string | undefined)[]): Promise<void> {
  for (const dir of dirs) {
    if (dir !== undefined)
      await bestEffort("atomic_temp_dir_cleanup", () =>
        fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }),
      );
  }
}

async function captureMode(target: string): Promise<number | undefined> {
  try {
    return (await fs.stat(target)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Refuse to operate on a path that is itself a symlink, so a write can never be
 * redirected through a link to a location outside the intended target.
 *
 * @param target - the path to inspect (not followed).
 * @throws {@link ToolError} with code `invalid_input` when `target` is a symlink.
 * @remarks A missing path is fine (the `lstat` failure is swallowed): only an
 *   existing symlink is rejected.
 */
export async function assertNotSymlink(target: string): Promise<void> {
  const lst = await fs.lstat(target).catch(() => null);
  if (lst?.isSymbolicLink()) {
    throw new ToolError("invalid_input", `Refusing to write through a symlink: ${target}`, {
      path: target,
    });
  }
}

/**
 * Apply the tools-specific symlink and mode-preservation policy around
 * `@clarvis/paths`' canonical durable atomic writer.
 *
 * @param target - the absolute path to write; parent directories are created as
 *   needed.
 * @param content - the UTF-8 text to persist.
 * @throws {@link ToolError} with code `invalid_input` when `target` is a symlink.
 * @remarks Atomic staging, retry, cleanup, payload fsync, and directory fsync
 * are owned by `@clarvis/paths`. This wrapper preserves the behavior specific
 * to coding tools: refusing a symlink, retaining an existing file's mode or
 * applying explicit reviewed configuration modes, using the host umask for an
 * ordinary new file/directory, and removing a parent directory this call
 * created if the write fails.
 */
export async function writeAtomic(
  target: string,
  content: string,
  review?: MutationReview,
  intent: "write" | "edit" = "write",
  modes?: { mode: number; dirMode: number },
): Promise<void> {
  if (review !== undefined)
    return review([{ type: "modify", path: target, content, intent, ...modes }], () =>
      writeAtomic(target, content, undefined, intent, modes),
    );
  await assertNotSymlink(target);
  const dir = path.dirname(target);
  const createdDir = await fs.mkdir(dir, {
    recursive: true,
    ...(modes === undefined ? {} : { mode: modes.dirMode }),
  });
  const mode = modes?.mode ?? (await captureMode(target));
  const umask = process.umask();
  try {
    await writeFileDurable(target, content, {
      mode: mode ?? 0o666 & ~umask,
      dirMode: modes?.dirMode ?? 0o777 & ~umask,
    });
  } catch (err) {
    await removeCreatedDirs([createdDir]);
    throw err;
  }
}

/**
 * One prepared filesystem mutation. File operations enter the all-or-nothing
 * {@link applyOpsAtomic} batch; directory removals use separate reviewed commits.
 *
 * @remarks `content` is the new file body for `create`/`modify` (and for a
 *   `rename` that also rewrites the file). `from` is the source path for a
 *   `rename` and is ignored otherwise.
 */
export interface FileOp {
  /** File create/modify/delete/rename, or a separately reviewed directory removal. */
  type: "create" | "modify" | "delete" | "rename" | "rmdir" | "rmtree";
  /** The destination/target path this op acts on. */
  path: string;
  /** The source path for a `rename`; unused by other op types. */
  from?: string;
  /** The new file body for `create`/`modify`, or an optional rewrite alongside a `rename`. */
  content?: string;
  /** Host review distinguishes a file edit from a full replacement write. */
  intent?: "write" | "edit";
  /** Explicit permission bits for a reviewed configuration destination. */
  mode?: number;
  /** Directory mode for a newly created protected parent. */
  dirMode?: number;
  /** A rename may replace a destination only when its caller explicitly allowed it. */
  overwrite?: boolean;
  /** Bound for a cross-filesystem rename staged as a copy. */
  maxBytes?: number;
  /** Bounded review preview for a recursive directory removal. */
  treeEntries?: readonly string[];
  /** Captured identity of every previewed entry. */
  treeRevision?: string;
}

interface Committed {
  op: FileOp;
  backup: string | undefined;
  fromBackup?: string;
  renamed?: boolean;
  crossDevice?: boolean;
}

interface CrossStage {
  readonly tmp: string;
  readonly source: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
}

async function assertSourceUnchanged(from: string, source: CrossStage["source"]): Promise<void> {
  let current;
  try {
    current = await fs.lstat(from, { bigint: true });
  } catch {
    throw new ToolError("revision_conflict", "Move source changed before commit.");
  }
  if (
    !current.isFile() ||
    current.dev !== source.dev ||
    current.ino !== source.ino ||
    current.size !== source.size ||
    current.mtimeNs !== source.mtimeNs ||
    current.ctimeNs !== source.ctimeNs
  )
    throw new ToolError("revision_conflict", "Move source changed before commit.");
}

async function stageCrossDevice(op: FileOp): Promise<CrossStage | undefined> {
  const from = op.from!;
  const to = op.path;
  await assertNotSymlink(from);
  try {
    await fs.stat(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ToolError("not_found", `Rename source does not exist: ${from}`, { path: from });
    throw error;
  }
  const source = await fs.open(
    from,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
  );
  try {
    const snapshot = await source.stat({ bigint: true });
    if (!snapshot.isFile()) throw new ToolError("not_a_file", "Move source is not a regular file.");
    const destination = await fs.stat(path.dirname(to), { bigint: true });
    if (snapshot.dev === destination.dev) return undefined;
    const maxBytes = op.maxBytes ?? 64 * 1024 * 1024;
    if (snapshot.size > BigInt(maxBytes))
      throw new ToolError("too_large", `Cross-filesystem move exceeds ${maxBytes} bytes.`);
    const tmp = tmpPathFor(to);
    const target = await fs.open(tmp, "wx", op.mode ?? Number(snapshot.mode & 0o777n));
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0n;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += BigInt(bytesRead);
        if (total > BigInt(maxBytes))
          throw new ToolError("too_large", `Cross-filesystem move exceeds ${maxBytes} bytes.`);
        let offset = 0;
        while (offset < bytesRead) {
          const written = await target.write(buffer, offset, bytesRead - offset);
          if (written.bytesWritten === 0)
            throw new ToolError("io_error", "Cross-device staging stopped writing.");
          offset += written.bytesWritten;
        }
      }
      await target.sync();
      await assertSourceUnchanged(from, snapshot);
      return { tmp, source: snapshot };
    } catch (error) {
      await bestEffort("atomic_cross_stage_cleanup", () =>
        fs.rm(tmp, { force: true, ...RM_RETRY }),
      );
      throw error;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

async function cleanupStaged(staged: Map<string, string>): Promise<void> {
  for (const tmp of staged.values())
    await bestEffort("atomic_staged_file_cleanup", () => fs.rm(tmp, { force: true, ...RM_RETRY }));
}

async function stageAll(
  ops: FileOp[],
  createdDirs: (string | undefined)[],
): Promise<{ staged: Map<string, string>; cross: Map<string, CrossStage> }> {
  const staged = new Map<string, string>();
  const cross = new Map<string, CrossStage>();
  try {
    for (const op of ops) {
      if (op.type === "create" || op.type === "modify") {
        const { tmp, createdDir } = await stage(
          op.path,
          op.content ?? "",
          op.mode === undefined || op.dirMode === undefined
            ? undefined
            : { mode: op.mode, dirMode: op.dirMode },
        );
        staged.set(op.path, tmp);
        createdDirs.push(createdDir);
      } else if (op.type === "rename") {
        if (op.content !== undefined) {
          const { tmp, createdDir } = await stage(
            op.path,
            op.content,
            op.mode === undefined || op.dirMode === undefined
              ? undefined
              : { mode: op.mode, dirMode: op.dirMode },
          );
          staged.set(op.path, tmp);
          createdDirs.push(createdDir);
          await assertNotSymlink(op.from!);
          const source = await fs.lstat(op.from!, { bigint: true });
          if (!source.isFile())
            throw new ToolError("not_a_file", "Move source is not a regular file.");
          const destination = await fs.stat(path.dirname(op.path), { bigint: true });
          if (source.dev !== destination.dev) {
            if (ops.length !== 1)
              throw new ToolError(
                "cross_device",
                "Cross-filesystem rename requires a single-file operation.",
              );
            cross.set(op.path, { tmp, source });
          }
        } else {
          createdDirs.push(
            await fs.mkdir(path.dirname(op.path), {
              recursive: true,
              ...(op.dirMode === undefined ? {} : { mode: op.dirMode }),
            }),
          );
          const copied = await stageCrossDevice(op);
          if (copied !== undefined) {
            staged.set(op.path, copied.tmp);
            if (ops.length !== 1)
              throw new ToolError(
                "cross_device",
                "Cross-filesystem rename requires a single-file operation.",
              );
            cross.set(op.path, copied);
          }
        }
      }
    }
  } catch (err) {
    await cleanupStaged(staged);
    throw err;
  }
  return { staged, cross };
}

/**
 * Pre-flight every op against the current filesystem and capture each target's
 * mode, so the commit phase can preserve permissions and never surprises on a
 * bad target.
 *
 * @param ops - the batch to validate.
 * @returns a map from each destination path to its existing permission bits, or
 *   `undefined` when the destination does not yet exist.
 * @throws {@link ToolError} when a target is a symlink (`invalid_input`), a
 *   rename source is missing (`not_found`) or a directory (`not_a_file`), a
 *   rename destination already exists (`invalid_input`), or a create/modify
 *   target is a directory (`not_a_file`).
 */
async function validateTargets(ops: FileOp[]): Promise<Map<string, number | undefined>> {
  const modes = new Map<string, number | undefined>();
  for (const op of ops) {
    if (op.type === "rename") {
      const from = op.from!;
      const to = op.path;
      await assertNotSymlink(from);
      await assertNotSymlink(to);
      let stFrom;
      try {
        stFrom = await fs.stat(from);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolError("not_found", `Rename source does not exist: ${from}`, { path: from });
        }
        throw err;
      }
      if (stFrom.isDirectory()) {
        throw new ToolError("not_a_file", `Rename source is a directory: ${from}`, { path: from });
      }
      let toExists = true;
      try {
        const destination = await fs.stat(to);
        if (destination.isDirectory())
          throw new ToolError("not_a_file", `Rename destination is a directory: ${to}`, {
            path: to,
          });
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") toExists = false;
        else throw err;
      }
      if (toExists && op.overwrite !== true) {
        throw new ToolError("invalid_input", `Rename destination already exists: ${to}`, {
          path: to,
        });
      }
      modes.set(to, stFrom.mode & 0o777);
      continue;
    }
    if (op.type !== "delete") await assertNotSymlink(op.path);
    let st;
    try {
      st = op.type === "delete" ? await fs.lstat(op.path) : await fs.stat(op.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      modes.set(op.path, undefined);
      continue;
    }
    if (st.isDirectory()) {
      throw new ToolError("not_a_file", `Path is a directory: ${op.path}`, { path: op.path });
    }
    if (op.type === "delete" && !st.isFile() && !st.isSymbolicLink())
      throw new ToolError("not_a_file", `Path is not a file or symlink: ${op.path}`, {
        path: op.path,
      });
    modes.set(op.path, st.mode & 0o777);
  }
  return modes;
}

/**
 * Apply the staged ops in order, moving each displaced original aside as a backup
 * so a mid-batch failure can be rolled back to the pre-batch state.
 *
 * @param ops - the batch to commit, in order.
 * @param staged - map from destination path to the temp file holding its new
 *   content (from {@link stageAll}).
 * @param modes - the per-target permission bits from {@link validateTargets}.
 * @returns the committed records (each op plus the backups it created), which the
 *   caller deletes once the whole batch has durably landed.
 * @throws the original error after undoing the ops applied so far; if an undo
 *   step itself fails, a {@link ToolError} with code `io_error` reports which
 *   originals could not be restored (their content is preserved in an adjacent
 *   `.clarvis-tmp-*` backup).
 */
async function commitWithRollback(
  ops: FileOp[],
  staged: Map<string, string>,
  modes: Map<string, number | undefined>,
  cross: Map<string, CrossStage>,
): Promise<Committed[]> {
  const committed: Committed[] = [];
  try {
    for (const op of ops) {
      if (op.type === "rename") {
        const from = op.from!;
        const to = op.path;
        const crossStage = cross.get(to);
        if (crossStage !== undefined) await assertSourceUnchanged(from, crossStage.source);
        await assertNotSymlink(to);
        const mode = op.mode ?? modes.get(to);
        const rec: Committed = { op, backup: undefined };
        committed.push(rec);
        const toBackup = tmpPathFor(to);
        try {
          await renameForTools(to, toBackup);
          rec.backup = toBackup;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const tmp = staged.get(to);
        if (tmp !== undefined) {
          if (crossStage === undefined) {
            const fromBkp = tmpPathFor(from);
            await renameForTools(from, fromBkp);
            rec.fromBackup = fromBkp;
          } else rec.crossDevice = true;
          if (mode !== undefined) await fs.chmod(tmp, mode);
          await renameForTools(tmp, to);
        } else {
          await renameForTools(from, to);
          rec.renamed = true;
        }
        continue;
      }
      const mode = op.mode ?? modes.get(op.path);
      let backup: string | undefined;
      const bkp = tmpPathFor(op.path);
      try {
        await renameForTools(op.path, bkp);
        backup = bkp;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        backup = undefined;
      }
      committed.push({ op, backup });
      if (op.type !== "delete") {
        const tmp = staged.get(op.path);
        if (tmp === undefined) throw new Error(`internal: no staged content for ${op.path}`);
        if (mode !== undefined) await fs.chmod(tmp, mode);
        await renameForTools(tmp, op.path);
      }
    }
  } catch (err) {
    await rollbackCommitted(committed, staged, err);
  }
  return committed;
}

async function rollbackCommitted(
  committed: Committed[],
  staged: Map<string, string>,
  error: unknown,
): Promise<never> {
  const unrestored: string[] = [];
  for (let i = committed.length - 1; i >= 0; i--) {
    const rec = committed[i]!;
    const { op, backup } = rec;
    try {
      if (op.type === "rename") {
        const from = op.from!;
        const to = op.path;
        if (rec.crossDevice) {
          await fs.rm(to, { force: true, ...RM_RETRY });
        } else if (rec.fromBackup !== undefined) {
          await fs.rm(to, { force: true, ...RM_RETRY });
          await renameForTools(rec.fromBackup, from);
        } else if (rec.renamed) {
          await renameForTools(to, from);
        }
        if (backup !== undefined) await renameForTools(backup, to);
        continue;
      }
      if (op.type !== "delete") await fs.rm(op.path, { force: true, ...RM_RETRY });
      if (backup !== undefined) await renameForTools(backup, op.path);
    } catch {
      if (op.type === "rename" && rec.renamed && rec.fromBackup === undefined) {
        unrestored.push(`${op.from} (original content preserved at ${op.path})`);
      } else {
        unrestored.push(
          `${op.type === "rename" ? op.from : op.path} ` +
            `(original content preserved in an adjacent ${TMP_GLOB} backup)`,
        );
      }
    }
  }
  await cleanupStaged(staged);
  if (unrestored.length > 0)
    throw new ToolError(
      "io_error",
      `${(error as Error).message}; rollback could not restore ${unrestored.join(", ")}`,
    );
  throw error;
}

/**
 * Apply a batch of {@link FileOp}s with staged writes and rollback before
 * publication. Cross-filesystem moves use a single-operation copy and unlink
 * path with an explicit partial outcome after the destination is committed.
 *
 * @param ops - the create/modify/delete/rename operations to apply, in order.
 * @throws {@link ToolError} from validation (see {@link validateTargets}) or an
 *   `io_error` when a rollback could not fully restore an original, or
 *   `commit_partial` when a cross-filesystem destination landed but source
 *   removal or durability could not be confirmed.
 * @remarks New content is staged to temp files and targets validated before any
 *   original is touched, so most failures abort with nothing changed. During
 *   commit each displaced original is kept as a backup and restored on failure;
 *   on success every affected directory is `fsync`ed and the backups/temps are
 *   removed. Permission bits of overwritten files are preserved.
 */
export async function applyOpsAtomic(ops: FileOp[], review?: MutationReview): Promise<void> {
  if (ops.some((op) => op.type === "rmdir" || op.type === "rmtree"))
    throw new ToolError(
      "invalid_input",
      "Directory removal uses the remove tool's reviewed commit.",
    );
  if (review !== undefined) return review(ops, () => applyOpsAtomic(ops));
  const createdDirs: (string | undefined)[] = [];
  try {
    const { staged, cross } = await stageAll(ops, createdDirs);

    let modes: Map<string, number | undefined>;
    try {
      modes = await validateTargets(ops);
    } catch (err) {
      await cleanupStaged(staged);
      throw err;
    }

    const committed = await commitWithRollback(ops, staged, modes, cross);

    const dirs = new Set<string>();
    for (const op of ops) {
      dirs.add(path.dirname(op.path));
      if (op.type === "rename" && op.from !== undefined) dirs.add(path.dirname(op.from));
    }
    try {
      for (const dir of dirs) await fsyncDir(dir);
    } catch (error) {
      await rollbackCommitted(committed, staged, error);
    }

    for (const [to, stagedSource] of cross) {
      const from = ops.find((op) => op.path === to)?.from;
      if (from === undefined) throw new Error("Cross-device move lost its source identity.");
      try {
        await assertSourceUnchanged(from, stagedSource.source);
        await fs.unlink(from);
        await fsyncDir(path.dirname(from));
      } catch {
        const sourceExists = await fs.lstat(from).then(
          () => true,
          () => false,
        );
        throw new ToolError(
          "commit_partial",
          "Destination was committed, but source removal could not be confirmed.",
          { source_exists: sourceExists, destination_committed: true },
        );
      }
    }

    for (const { backup, fromBackup } of committed) {
      if (backup !== undefined)
        await bestEffort("atomic_backup_cleanup", () =>
          fs.rm(backup, { force: true, ...RM_RETRY }),
        );
      if (fromBackup !== undefined)
        await bestEffort("atomic_source_backup_cleanup", () =>
          fs.rm(fromBackup, { force: true, ...RM_RETRY }),
        );
    }
  } catch (err) {
    await removeCreatedDirs(createdDirs);
    throw err;
  }
}
