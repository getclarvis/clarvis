/**
 * File-backed {@link MemoryStore} over a memory root (`<ws>/.clarvis/memory`).
 *
 * The tree IS the memory: one `.md` per document, no sidecar JSON beyond the
 * run-dedup ledger. Writes are atomic (tmp + rename), directories 0700, files
 * 0600 — via `@clarvis/paths`' atomic-write family. An exclusive directory
 * lock (mkdir-based, with a heartbeat and stale-steal) serializes multi-step
 * read-modify-write such as an index pass. Scans tolerate unreadable entries;
 * a direct read reports an oversized hand-edited document explicitly rather
 * than pretending protected bytes are absent.
 */
import { randomBytes } from "node:crypto";

import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import { runBatch, type BatchPrimitives } from "./batch.ts";
import { createDocumentRepository } from "./file-store/documents.ts";
import { createJobRepository } from "./file-store/jobs.ts";
import { createJournalRepository } from "./file-store/journal.ts";
import { createFileStoreLayout } from "./file-store/layout.ts";
import { createTreeLock } from "./file-store/lock.ts";
import { createRecoveryCoordinator } from "./file-store/recovery.ts";
import { createRevisionRepository } from "./file-store/revisions.ts";
import type { MemoryBatchCommit } from "./journal.ts";
import type {
  MemoryBatch,
  MemoryBatchInput,
  MemoryStore,
  MemoryTx,
  MemoryUnitOfWork,
} from "./types.ts";

/** A held lock is refreshed by heartbeat; an mtime older than this means the
 * holder died. The wait timeout must comfortably exceed a full index pass. */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_TIMEOUT_MS = 180_000;
/**
 * Superseded document bodies, mirroring the tree's own shape: a directory
 * literally named `infra/bun/MEMORY.md` holding one `<rev>.md` / `<rev>.json`
 * pair per revision. Legal on every filesystem, and self-evident to a human
 * browsing `.clarvis/`. Dot-prefixed, so it is invisible to `list`/`grep`.
 */
/** In-flight and interrupted batches, one directory per batch. */
/** Options for {@link createFileMemoryStore}. */
export interface CreateFileMemoryStoreOptions {
  /** Absolute path of the memory root: the wiki's Markdown, and nothing else. */
  root: string;
  /**
   * Absolute path of the machinery root — revision history, the batch journal,
   * the durable index queue and the tree lock.
   *
   * @remarks Defaults to {@link CreateFileMemoryStoreOptions.root}, which keeps
   * a self-contained tree for tests and for any host that wants one. The
   * product passes the workspace's *state* root instead, so that
   * `<ws>/.clarvis/memory` holds only `.md` files a human would want to read and
   * every byte of bookkeeping lives outside the working tree.
   *
   * Splitting the two costs nothing in atomicity: a document is published by
   * {@link writeFileAtomic}, whose temp file is a sibling of the target under
   * {@link CreateFileMemoryStoreOptions.root}, so the `rename` stays within one
   * filesystem. The journal records *what* a batch will do; it is not the
   * payload being renamed into place.
   */
  machineryRoot?: string;
  /**
   * The working tree {@link CreateFileMemoryStoreOptions.root} sits inside.
   *
   * @remarks When given, the wiki root is created through
   * `ensureWorkspaceSubdir`, so the workspace `.gitignore` is seeded by the one
   * function that owns it rather than by whichever writer happened to run
   * first. Omitted (a server's per-owner tree, or a test), the root is created
   * directly.
   */
  workspaceRoot?: string;
  /** Injectable clock (epoch ms); used as the `updated_at` fallback when a
   * file's mtime cannot be read, and to stamp ledger entries. Defaults to
   * `Date.now`. */
  clock?: () => number;
  /**
   * Overrides for the tree lock's timing, in milliseconds.
   *
   * @remarks Present so a test can exercise the wait's give-up path in
   * milliseconds rather than in the three minutes production wants, and its
   * stale-steal without a real minute of silence. A host has no reason to set
   * it; the defaults are {@link LOCK_STALE_MS}, {@link LOCK_HEARTBEAT_MS} and
   * {@link LOCK_TIMEOUT_MS}.
   */
  lock?: { staleMs?: number; heartbeatMs?: number; timeoutMs?: number; warnMs?: number };
  /**
   * Where this store reports what it did to the tree behind the caller's back.
   *
   * @remarks Journal recovery rewrites documents, the tree lock can be held
   * across an inference, and a corrupt queue record silently loses a run's
   * learning — none of which any return value carries. The host supplies
   * `componentLogger("memory")`; absent one every site resolves to
   * {@link NOOP_LOGGER}.
   */
  logger?: Logger;
}

/**
 * Build a file-backed {@link MemoryStore} rooted at `opts.root`. The root is
 * created lazily on first use; every relative path is normalized and
 * traversal-guarded by `normalizeMemoryPath` and must end in `.md`.
 *
 * @param opts - the memory root, an optional injectable clock, and optional
 *   lock timing overrides.
 * @returns a {@link MemoryStore} whose scans tolerate unreadable entries, whose
 *   direct reads reject oversized persisted documents explicitly, and whose
 *   writes are atomic (tmp + `rename`, dirs 0700, files 0600).
 * @remarks {@link MemoryStore.exclusive} takes an exclusive, mkdir-based
 *   directory lock with a heartbeat and stale-steal, serializing multi-step
 *   read-modify-write such as an index pass, and hands the caller a
 *   {@link MemoryTx} handle to use inside. It provides **exclusion only, not
 *   rollback**: a throw part-way through leaves earlier writes applied. A held
 *   lock whose holder-dir mtime exceeds {@link LOCK_STALE_MS} and whose recorded
 *   pid is dead is stolen; acquisition gives up after {@link LOCK_TIMEOUT_MS}.
 *   Nesting is tolerated (a nested call runs without re-acquiring) as a safety
 *   net, but callers must thread the handle rather than rely on it.
 * @throws {@link MemoryPathError} when a caller-supplied path is absolute,
 *   escapes the root, or is not a `.md` file.
 * @throws Error when the lock wait times out.
 */
export function createFileMemoryStore(opts: CreateFileMemoryStoreOptions): MemoryStore {
  const layout = createFileStoreLayout(opts);
  const { root, machineryRoot, lockDir } = layout;
  const init = () => layout.init();
  const logger = opts.logger ?? NOOP_LOGGER;
  const clock = opts.clock ?? ((): number => Date.now());
  const lockStaleMs = opts.lock?.staleMs ?? LOCK_STALE_MS;
  const lockHeartbeatMs = opts.lock?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const lockTimeoutMs = opts.lock?.timeoutMs ?? LOCK_TIMEOUT_MS;
  const revisions = createRevisionRepository({ machineryRoot, init });
  const jobs = createJobRepository({ machineryRoot, init, logger });
  const journal = createJournalRepository({ machineryRoot, init });
  const documents = createDocumentRepository({ root, init, clock });
  const treeLock = createTreeLock({
    lockDir,
    staleMs: lockStaleMs,
    heartbeatMs: lockHeartbeatMs,
    timeoutMs: lockTimeoutMs,
    init,
    logger,
    ...(opts.lock?.warnMs !== undefined ? { warnMs: opts.lock.warnMs } : {}),
  });

  const tx: MemoryTx = {
    ...documents,

    async wasIndexed(runId) {
      return jobs.wasIndexed(runId);
    },

    async markIndexed(runId) {
      await jobs.markIndexed(runId, clock());
    },
  };

  /** Perform a batch's declared follow-up work. Every step is idempotent so
   * roll-forward recovery can repeat it safely. */
  async function runCommit(commit: MemoryBatchCommit): Promise<void> {
    if (commit.mark_indexed !== undefined) await tx.markIndexed(commit.mark_indexed);
  }
  const recovery = createRecoveryCoordinator({
    init,
    journal,
    tree: tx,
    revisions,
    runCommit,
    logger,
  });

  function batchPrimitives(): BatchPrimitives {
    return {
      readTree: (relPath) => tx.read(relPath),
      writeTree: (relPath, content) => tx.write(relPath, content),
      deleteTree: (relPath) => tx.delete(relPath),
      listTree: () => tx.list(),
      async putRevision(revision, body) {
        await revisions.put(revision, body);
      },
      async lastInstalledDigest(relPath) {
        return revisions.lastInstalledDigest(relPath);
      },
      async writeJournal(record) {
        await journal.write(record);
      },
      markApplied: (batchId) => journal.markApplied(batchId),
      markCommitted: (batchId) => journal.markCommitted(batchId),
      sweepJournal: (batchId) => journal.sweep(batchId),
      runCommit,
      async pruneHistory(paths) {
        await revisions.prune(paths, clock());
      },
      now: clock,
      newBatchId: () => `${clock().toString(36)}-${randomBytes(6).toString("hex")}`,
    };
  }

  const unitOfWork: MemoryUnitOfWork = {
    ...tx,
    revisions,
    jobs: jobs.tx,
    async batch<T>(input: MemoryBatchInput, fn: (bx: MemoryBatch) => Promise<T>): Promise<T> {
      recovery.assertWritable();
      return runBatch(batchPrimitives(), input, fn);
    },
  };

  async function exclusive<T>(fn: (handle: MemoryUnitOfWork) => Promise<T>): Promise<T> {
    if (treeLock.nested()) return fn(unitOfWork);
    return treeLock.run(async () => {
      await recovery.recoverOnce();
      return fn(unitOfWork);
    });
  }

  return { ...tx, exclusive, revisions, jobs: jobs.reader, recover: () => recovery.recover() };
}
