/**
 * File-backed {@link PlanRepository} rooted at `<workspaceRoot>/.clarvis/plans/`.
 *
 * One Markdown file per plan, named `yyyy-MM-ddTHH-mm-ss-<slug>.md` so a human
 * can find and open it. Writes are atomic (fsync'd tmp file, `rename`, then an
 * fsync of the directory) under 0600/0700; paths are confined to the plans root
 * and symlinks are rejected. Compare-and-swap is serialized per plan by a
 * reentrant in-process mutex plus an on-disk lockfile, so a second process
 * cannot interleave a read-modify-write.
 *
 * Plans are keyed by {@link PlanRecord.id}; the filename is only a locator, so
 * the adapter keeps a memoized id → filename index and falls back to a
 * frontmatter-only scan when it misses.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  acquireLocalLease,
  ensureWorkspaceDir,
  ensureWorkspaceSubdir,
  tmpPathFor,
  workspacePaths,
  workspaceStatePaths,
} from "@clarvis/paths";

import { PLAN_CURSOR_TAGS, decodePlanCursor, encodePlanCursor } from "./cursor.ts";
import { digestText, parsePlan, projectPlan } from "./format.ts";
import {
  MAX_PLAN_DIRECTORY_ENTRIES,
  MAX_PLAN_DOCUMENT_BYTES,
  MAX_PLAN_FILENAME_WINDOW,
  MAX_PLAN_FRONTMATTER_BYTES,
  MAX_PLAN_LIST_PAGE_BYTES,
  MAX_PLAN_LOCATOR_CHARS,
  assertPlanSourceSize,
  planSourceByteLength,
} from "./limits.ts";
import { boundedPlanReason } from "./log.ts";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  type PlanRecord,
  type PlanRepository,
} from "./repository.ts";

/**
 * Wait budget for the on-disk lockfile: 1000 attempts, 10ms apart.
 *
 * @remarks Ten seconds, not the two the first 200 attempts bought. The budget
 * has to exceed the time a *queue* of contending writers takes to drain, not the
 * time one holder keeps the lock: every waiter behind the queue is still waiting
 * while the ones ahead of it each take, write, fsync and release. Twenty-four
 * concurrent writers on a slow filesystem exhausted two seconds and reported a
 * timeout for a lock nobody was holding — `plan.test.ts`'s contention case,
 * intermittently red on the Windows runner.
 *
 * It also stays comfortably under {@link LOCK_STALE_MS}: ordinary contention
 * gets a bounded answer before a lease is even eligible for crash recovery,
 * while a later attempt can reclaim it once the grace and owner-liveness check
 * both say the writer is gone.
 *
 * Which of the two factors carries the budget is not arbitrary.
 * {@link LOCK_RETRY_MS} is the *granularity*: it is how long a freed lock goes
 * unnoticed, so it is the latency this waiter adds to every handoff in a queue,
 * and it is set below the cost of the fsync-ed write each holder performs so
 * that it never dominates one. The attempt count is then just the budget divided
 * by that granularity, and is the factor to change if the budget moves.
 */
const LOCK_ATTEMPTS = 1000;
const LOCK_RETRY_MS = 10;
/** Age after which a lock becomes eligible for owner-liveness recovery. */
const LOCK_STALE_MS = 30_000;
/** Keep a live writer comfortably younger than the stale-recovery threshold. */
const LOCK_HEARTBEAT_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const READ_ONLY_FLAGS =
  constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

/** Options for {@link createFilePlanRepository}. */
export interface CreateFilePlanRepositoryOptions {
  /** The workspace the plans root must stay inside; also the anchor a record's
   * `index.path` is rendered relative to. */
  workspaceRoot: string;
  /**
   * Absolute plans root. Defaults to `<workspaceRoot>/.clarvis/plans`; a host
   * that separates plans per owner passes
   * `<workspaceRoot>/.clarvis/owners/<segment>/plans`.
   *
   * @remarks Must resolve inside `workspaceRoot` — a root that escapes it is
   * rejected on the first operation, so this option cannot be used to write
   * anywhere on the filesystem. Owner separation works by making the *root*
   * owner-scoped rather than nesting owners beneath a shared root, because a
   * plan must be a direct child of its root (see `confined`).
   */
  root?: string;
  /**
   * Directory the compare-and-swap lockfiles are taken in. Defaults to the
   * workspace's state tree under the user's global root; a host that separates
   * owners passes that owner's lock directory.
   *
   * @remarks Separate from {@link CreateFilePlanRepositoryOptions.root} so the
   * plans directory holds only the plan documents themselves. A lockfile is
   * bookkeeping about a write in flight, not a record of anything, and a `.lock`
   * left behind by a crash is exactly the sort of debris a working tree should
   * never accumulate. Unlike a temp file, a lock is never renamed over a plan,
   * so nothing about atomicity depends on it being a sibling.
   */
  lockDir?: string;
  /**
   * Operator diagnostics for a stored document this adapter skips.
   *
   * @remarks Both scanning paths below drop an unreadable or unparsable file and
   * continue, which is the right behaviour — one broken plan must not make the
   * rest unlistable — but it used to be entirely silent, so a plan that had
   * simply vanished from `list_plans` looked exactly like a plan that had never
   * been written. Optional only because the property cannot carry a default; it
   * is resolved to {@link NOOP_LOGGER} once at construction.
   */
  logger?: Logger;
}

/** Extract a plan's `id` from a bounded frontmatter prefix. */
function idFromFrontmatterPrefix(source: string): string | null {
  const opening = /^---\r?\n/.exec(source);
  if (opening === null) return null;
  const remainder = source.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/m.exec(remainder);
  const frontmatter = closing === null ? remainder : remainder.slice(0, closing.index);
  const match = /^id:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter);
  const id = match?.[1]?.replace(/^["']|["']$/g, "") ?? null;
  return id !== null && id.length <= MAX_PLAN_LOCATOR_CHARS ? id : null;
}

function assertPlanLocator(value: string, label: string): void {
  if (value.length === 0 || value.length > MAX_PLAN_LOCATOR_CHARS)
    throw new RangeError(`${label} must contain 1-${MAX_PLAN_LOCATOR_CHARS} characters`);
}

/**
 * Stamp a filename bound as this adapter's own paging cursor.
 *
 * @remarks The payload is a filename rather than an id because paging here is a
 * descending lexical bound over the directory, which is also why a bound whose
 * plan has since been deleted still pages correctly.
 */
function fileCursor(name: string): string {
  return encodePlanCursor(PLAN_CURSOR_TAGS.file, name);
}

/**
 * Recover the filename bound from a cursor this adapter minted.
 *
 * @throws {@link PlanCursorError} when the cursor came from another backend,
 *   which would otherwise be read as a bound and silently restart the listing.
 */
function fileCursorBound(cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : decodePlanCursor(PLAN_CURSOR_TAGS.file, cursor);
}

/**
 * Read from one already-opened inode, bounding allocation before decoding.
 * A pre/post descriptor stat rejects files that grow or are replaced during
 * the read instead of returning a partial mixture of two revisions.
 */
async function readBoundedUtf8(path: string, maxBytes: number, prefix = false): Promise<string> {
  const handle = await open(path, READ_ONLY_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Plan path is not a regular file");
    if (!prefix && before.size > maxBytes)
      throw new RangeError(`Plan document exceeds ${maxBytes} UTF-8 bytes`);
    const capacity = prefix
      ? Math.max(1, Math.min(maxBytes, before.size || 1))
      : Math.max(1, Math.min(maxBytes + 1, before.size + 1));
    const buffer = Buffer.allocUnsafe(capacity);
    let total = 0;
    while (total < capacity) {
      const { bytesRead } = await handle.read(buffer, total, capacity - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Plan document changed while it was being read");
    if (!prefix && total > maxBytes)
      throw new RangeError(`Plan document exceeds ${maxBytes} UTF-8 bytes`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Build the file-backed {@link PlanRepository} for a workspace.
 *
 * @param options - the workspace root; see {@link CreateFilePlanRepositoryOptions}.
 * @returns a repository storing one Markdown file per plan under
 *   `<workspaceRoot>/.clarvis/plans`.
 * @remarks Safe to use concurrently: same-plan writes are serialized and a
 *   losing compare-and-swap raises {@link PlanConflictError} rather than
 *   clobbering. An unparseable file is reported through {@link InvalidPlanError}
 *   and never overwritten or deleted as a side effect.
 */
export function createFilePlanRepository(options: CreateFilePlanRepositoryOptions): PlanRepository {
  const workspaceRoot = resolve(options.workspaceRoot);
  const root =
    options.root === undefined ? workspacePaths(workspaceRoot).plansRoot : resolve(options.root);
  const lockDir =
    options.lockDir === undefined
      ? workspaceStatePaths(workspaceRoot).plansLockDir
      : resolve(options.lockDir);
  const logger = options.logger ?? NOOP_LOGGER;
  const locks = new Map<string, Promise<void>>();
  const lockContext = new AsyncLocalStorage<Set<string>>();

  /**
   * Create the lock directory once per repository, not once per acquisition.
   *
   * @remarks Memoized because it sits on the contention path: every waiter runs
   * it before its first exclusive-create, so an un-memoized `mkdir` charges a
   * syscall per contending writer to a wait that is already racing a deadline.
   */
  let lockDirReady: Promise<void> | null = null;
  const ensureLockDir = (): Promise<void> => {
    lockDirReady ??= mkdir(lockDir, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((error: unknown) => {
        lockDirReady = null;
        throw error;
      });
    return lockDirReady;
  };
  /** Memoized id → filename, refreshed by a scan whenever it misses. */
  const locators = new Map<string, string>();

  /** Create the plans root if missing, fix its permissions, and verify it is a
   * real directory that has not escaped the workspace root — through a symlink
   * or through a host-supplied `root`.
   *
   * @remarks Two distinct checks, in order: a lexical containment check on the
   * (already `resolve`d, but not yet existing) paths runs first and rejects a
   * `root` a host pointed somewhere else entirely, before anything is created
   * on disk. The `realpath` comparison after `mkdir` catches the check the
   * lexical one cannot — an intermediate symlink making a lexically-contained
   * path resolve outside the workspace — which by nature requires the path to
   * exist first.
   *
   * The `mkdir` goes through `ensureWorkspaceSubdir` so that creating the plans
   * directory also seeds the workspace `.gitignore`. It used to `mkdir` on its
   * own, which meant the ignore file existed only if some *other* writer had
   * happened to run first — the exact ordering defect `ensureWorkspaceDir` was
   * introduced to remove, reappearing one directory down. */
  async function ensureRoot(): Promise<void> {
    const lexicalRel = relative(workspaceRoot, root);
    if (lexicalRel === ".." || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
      throw new Error("Plans root escapes the workspace");
    }
    const clarvisDir = workspacePaths(workspaceRoot).clarvisDir;
    const fromClarvis = relative(clarvisDir, root);
    if (fromClarvis === "") {
      ensureWorkspaceDir(workspaceRoot);
    } else if (
      fromClarvis !== ".." &&
      !fromClarvis.startsWith(`..${sep}`) &&
      !isAbsolute(fromClarvis)
    ) {
      ensureWorkspaceSubdir(root, workspaceRoot);
    } else {
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new Error("Plans root must be a directory");
    const [actualRoot, actualWorkspace] = await Promise.all([
      realpath(root),
      realpath(workspaceRoot),
    ]);
    const rel = relative(actualWorkspace, actualRoot);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Plans root escapes the workspace");
    await chmod(root, 0o700);
  }

  /** Resolve `name` to an absolute path proven to sit directly inside the plans
   * root, rejecting traversal and symlinks. */
  async function confined(name: string, existing = true): Promise<string> {
    await ensureRoot();
    const target = resolve(isAbsolute(name) ? name : join(root, name));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Plan path escapes plans root");
    const parent = await realpath(dirname(target));
    if (parent !== (await realpath(root)))
      throw new Error("Plan path must be directly inside plans root");
    if (existing) {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile())
        throw new Error("Plan path is not a regular file");
    }
    return target;
  }

  /**
   * Best-effort `fsync` of a directory, durably persisting a rename of one of
   * its entries.
   *
   * @remarks Windows will not open or sync a directory handle the way this
   *   needs, so a failure there is a no-op rather than a failed write - left
   *   unguarded this throws, and since the caller's `catch` rethrows, every
   *   plan write on Windows fails after the plan has already been renamed into
   *   place. On every other platform a failure here is a real durability
   *   problem (disk full, EIO, a quota) and still propagates: silently
   *   swallowing it there would let a write report success while the rename
   *   might not survive a crash.
   *
   *   This is deliberately **not** `@clarvis/paths`' `fsyncDir`, which never
   *   throws on any platform. That posture is right for a trace record or a
   *   memory revision, where losing the last write to a crash costs a little
   *   history; a plan is the auditable record of what the agent intended and
   *   did, and a durability failure there must be reported rather than
   *   swallowed. The two disagree on purpose, and this comment is why the
   *   duplication stays.
   */
  async function fsyncDir(): Promise<void> {
    const canSyncDirectory = process.platform !== "win32";
    let directory;
    try {
      directory = await open(root, constants.O_RDONLY);
    } catch (error) {
      if (canSyncDirectory) throw error;
      return;
    }
    try {
      await directory.sync();
    } catch (error) {
      if (canSyncDirectory) throw error;
      return;
    } finally {
      await directory.close();
    }
  }

  /**
   * Durably write `content` to `path`: fsync a private tmp file, `rename` it
   * over the target, then fsync the directory.
   *
   * @remarks The temp name comes from `@clarvis/paths`' `tmpPathFor` rather
   *   than being spelled here. It used to be `.<name>.<uuid>.tmp`, which is a
   *   shape nothing else in the monorepo recognises — so an orphan left by a
   *   crash matched neither `TMP_GLOB` nor `INTERNAL_IGNORE_PATTERNS`, and
   *   showed up in `git status` and in `grep`/`glob` inside the one directory
   *   this whole change exists to keep clean. `tmpPathFor` carries
   *   `TMP_PREFIX`, which both rules already hide.
   *
   *   The temp file stays a *sibling* of the plan, under the plans root,
   *   because `rename` is atomic only within one filesystem. That is the one
   *   thing the lockfile move could not take out of the working tree.
   */
  async function atomicWrite(path: string, content: string): Promise<void> {
    assertPlanSourceSize(content);
    const tmp = tmpPathFor(path);
    const handle = await open(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
      await chmod(path, 0o600);
      await fsyncDir();
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /** A plan's path as a caller sees it: workspace-relative, forward-slashed. */
  const publicPath = (path: string): string => relative(workspaceRoot, path).split(sep).join("/");

  /** Run `operation` holding the exclusive lock for `key`, combining an
   * in-process mutex with an on-disk lockfile. Reentrant.
   *
   * @remarks The lockfile is taken in {@link CreateFilePlanRepositoryOptions.lockDir},
   * outside the working tree, so a `.lock` orphaned by a crash never appears in
   * a repository. The in-process mutex is still keyed on the same string, so
   * two repositories over one plans root serialize exactly as before. */
  async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = join(lockDir, key);
    const held = lockContext.getStore();
    if (held?.has(lockKey)) return operation();
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    locks.set(lockKey, tail);
    await previous;
    const lockPath = `${lockKey}.lock`;
    let lease: Awaited<ReturnType<typeof acquireLocalLease>> | undefined;
    try {
      await ensureLockDir();
      lease = await acquireLocalLease(lockPath, {
        staleMs: LOCK_STALE_MS,
        waitMs: LOCK_ATTEMPTS * LOCK_RETRY_MS,
        retryMs: LOCK_RETRY_MS,
        heartbeatMs: LOCK_HEARTBEAT_MS,
      });
      if (lease === null) throw new PlanConflictError("Timed out waiting for plan lock", "locked");
      await lease.assertOwned();
      return await lockContext.run(new Set([...(held ?? []), lockKey]), operation);
    } finally {
      try {
        await lease?.release();
      } finally {
        release();
        if (locks.get(lockKey) === tail) locks.delete(lockKey);
      }
    }
  }

  /**
   * Stream regular Markdown entries without materialising the directory.
   * Counting every entry (not only plans) prevents unrelated workspace debris
   * from making a repository scan unbounded.
   */
  async function* planEntries(): AsyncGenerator<{ name: string; path: string }> {
    await ensureRoot();
    const directory = await opendir(root);
    let examined = 0;
    for await (const entry of directory) {
      examined += 1;
      if (examined > MAX_PLAN_DIRECTORY_ENTRIES)
        throw new RangeError(`Plans directory exceeds ${MAX_PLAN_DIRECTORY_ENTRIES} entries`);
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      yield { name: entry.name, path: join(root, entry.name) };
    }
  }

  /**
   * Select the newest bounded filename window below `beforeExclusive`.
   * The directory can therefore be paged in exact lexical order while memory
   * stays O(window), even when filters require several scan windows.
   */
  async function filenameWindow(beforeExclusive: string | undefined): Promise<string[]> {
    const windowSize = MAX_PLAN_FILENAME_WINDOW;
    const selected: string[] = [];
    for await (const { name } of planEntries()) {
      if (beforeExclusive !== undefined && name >= beforeExclusive) continue;
      let low = 0;
      let high = selected.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (selected[middle]! > name) low = middle + 1;
        else high = middle;
      }
      selected.splice(low, 0, name);
      if (selected.length > windowSize) selected.pop();
    }
    return selected;
  }

  /**
   * Report a plan file this adapter could not read or parse.
   *
   * @param name - the plan's filename; only its basename is logged, because the
   *   containing directory is an owner-scoped path and adds nothing an operator
   *   cannot already derive.
   * @param error - what the read or parse threw.
   * @param layer - which scan skipped it, `rescan` (frontmatter-prefix locator
   *   rebuild) or `list` (full-document paging).
   * @remarks The reason goes through {@link boundedPlanReason}: a parse failure
   *   can quote the document it failed on, and a plan document is never logged.
   */
  function unparsable(name: string, error: unknown, layer: "rescan" | "list"): void {
    logger.warn(
      {
        event: "plan.document.unparsable",
        path: basename(name),
        reason: boundedPlanReason(error),
        layer,
      },
      "a plan file could not be read and is skipped; the file is left untouched",
    );
  }

  /** Parse `source` (read from `path`) into a {@link PlanRecord}, wrapping a
   * parse failure in {@link InvalidPlanError}. */
  function toRecord(source: string, path: string): PlanRecord {
    let document;
    try {
      document = parsePlan(source, publicPath(path));
    } catch (error) {
      throw new InvalidPlanError(error instanceof Error ? error.message : String(error));
    }
    return {
      id: document.id,
      source,
      digest: digestText(source),
      index: projectPlan(document),
    };
  }

  /** Read one complete canonical document under the package's hard byte cap. */
  async function readPlanSource(path: string): Promise<string> {
    try {
      return await readBoundedUtf8(path, MAX_PLAN_DOCUMENT_BYTES);
    } catch (error) {
      if (error instanceof RangeError) throw new InvalidPlanError(error.message);
      throw error;
    }
  }

  /** Rebuild the id → filename memo, reading at most the frontmatter prefix. */
  async function rescan(): Promise<void> {
    const next = new Map<string, string>();
    for await (const { name, path } of planEntries()) {
      let prefix: string;
      try {
        prefix = await readBoundedUtf8(path, MAX_PLAN_FRONTMATTER_BYTES, true);
      } catch (error) {
        unparsable(name, error, "rescan");
        continue;
      }
      const id = idFromFrontmatterPrefix(prefix);
      const previous = id === null ? undefined : next.get(id);
      if (id !== null && (previous === undefined || name > previous)) next.set(id, name);
    }
    locators.clear();
    for (const [id, name] of next) locators.set(id, name);
  }

  /**
   * The filename holding `id`, or null. Consults the memo
   * first and rescans once on a miss or a stale hit. Deliberately **does not
   * parse**: locating, compare-and-swap and deletion all work on bytes, so a
   * hand-corrupted plan stays addressable and therefore recoverable.
   */
  async function locate(
    id: string,
    allowRescan = true,
  ): Promise<{ name: string; path: string } | null> {
    const name = locators.get(id);
    if (name !== undefined) {
      try {
        const path = await confined(name);
        const prefix = await readBoundedUtf8(path, MAX_PLAN_FRONTMATTER_BYTES, true);
        if (idFromFrontmatterPrefix(prefix) === id) return { name, path };
      } catch {
        /* fall through to a rescan */
      }
      locators.delete(id);
    }
    if (!allowRescan) return null;
    await rescan();
    return locators.has(id) ? locate(id, false) : null;
  }

  return {
    async create(record) {
      assertPlanLocator(record.id, "Plan id");
      assertPlanSourceSize(record.source);
      await ensureRoot();
      return withLock(".allocation", async () => {
        if ((await locate(record.id)) !== null)
          throw new PlanConflictError(`Plan already exists: ${record.id}`, "cas");
        const initial = record.index.path.split("/").pop() ?? "plan.md";
        const extension = ".md";
        const stem = initial.endsWith(extension) ? initial.slice(0, -extension.length) : initial;
        let name = `${stem}${extension}`;
        let suffix = 1;
        for (;;) {
          const candidate = await confined(name, false);
          try {
            await access(candidate);
            suffix += 1;
            name = `${stem}-${suffix}${extension}`;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
        }
        const path = await confined(name, false);
        await atomicWrite(path, record.source);
        locators.set(record.id, name);
        return {
          id: record.id,
          source: record.source,
          digest: digestText(record.source),
          index: { ...record.index, path: publicPath(path) },
        };
      });
    },

    async read(id) {
      assertPlanLocator(id, "Plan id");
      const found = await locate(id);
      return found === null ? null : toRecord(await readPlanSource(found.path), found.path);
    },

    async list(query = {}) {
      if (query.cursor !== undefined) assertPlanLocator(query.cursor, "Plan cursor");
      const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
      const records: PlanRecord[] = [];
      let pageBytes = 0;
      let before = fileCursorBound(query.cursor);
      for (;;) {
        const names = await filenameWindow(before);
        if (names.length === 0) return { records };
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index]!;
          /**
           * The name this loop consumed before `name`, i.e. the cursor a caller
           * resumes the page from.
           *
           * @remarks Undefined only on the very first iteration of the very
           *   first window, where `records` is still empty — so it is asserted
           *   rather than branched on at the two places it is read, each of
           *   which is reached only once at least one record has been collected
           *   (`records.length >= limit >= 1`, or `records.length > 0`).
           */
          const previousName = before;
          before = name;
          let record: PlanRecord;
          try {
            const path = join(root, name);
            record = toRecord(await readPlanSource(path), path);
          } catch (error) {
            unparsable(name, error, "list");
            continue;
          }
          locators.set(record.id, name);
          if (query.status !== undefined && record.index.status !== query.status) continue;
          if (query.retention !== undefined && record.index.retention !== query.retention) continue;
          if (records.length >= limit) return { records, next_cursor: fileCursor(previousName!) };
          const recordBytes = planSourceByteLength(record.source);
          if (records.length > 0 && pageBytes + recordBytes > MAX_PLAN_LIST_PAGE_BYTES)
            return { records, next_cursor: fileCursor(previousName!) };
          records.push(record);
          pageBytes += recordBytes;
        }
        if (names.length < MAX_PLAN_FILENAME_WINDOW) return { records };
      }
    },

    async write(input) {
      assertPlanLocator(input.id, "Plan id");
      assertPlanSourceSize(input.source);
      const existing = await locate(input.id);
      if (existing === null) throw new PlanNotFoundError(input.id);
      return withLock(existing.name, async () => {
        const path = await confined(existing.name);
        if (digestText(await readPlanSource(path)) !== input.expectedDigest)
          throw new PlanConflictError("Plan changed since it was read", "cas");
        await atomicWrite(path, input.source);
        return {
          id: input.id,
          source: input.source,
          digest: digestText(input.source),
          index: { ...input.index, path: publicPath(path) },
        };
      });
    },

    async delete(id, expectedDigest) {
      assertPlanLocator(id, "Plan id");
      const existing = await locate(id);
      if (existing === null) return false;
      return withLock(existing.name, async () => {
        try {
          const path = await confined(existing.name);
          if (
            expectedDigest !== undefined &&
            digestText(await readPlanSource(path)) !== expectedDigest
          )
            throw new PlanConflictError("Plan changed since it was read", "cas");
          await unlink(path);
          locators.delete(id);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
    },
  };
}
