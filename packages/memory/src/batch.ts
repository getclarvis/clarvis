/**
 * The batch engine: staging, revision capture and commit ordering.
 *
 * Every backend needs identical semantics here — what gets staged, which
 * bodies become revisions, and the exact order in which the journal, the tree
 * writes and the markers land — so the sequence lives once, over a small
 * primitive port each backend implements. A backend that cannot outlive its
 * process supplies a no-op journal; the staging and revision behaviour is the
 * same either way.
 */
import { parseFrontmatter } from "./frontmatter.ts";
import { compareMemoryPaths, memoryDocKind, normalizeMemoryPath } from "./paths.ts";
import { digestBody, newRevisionId, type MemoryRevision } from "./revisions.ts";
import {
  assertMemoryPayloadBytes,
  assertMemoryStorageCount,
  MEMORY_STORAGE_LIMITS,
} from "./storage-limits.ts";
import {
  JOURNAL_VERSION,
  type MemoryBatchCommit,
  type MemoryJournalOp,
  type MemoryJournalRecord,
} from "./journal.ts";
import type { MemoryBatch, MemoryBatchInput, MemoryDoc, MemoryTx } from "./types.ts";

/** One staged operation, before it is turned into a journal entry. */
interface StagedOp {
  op: "write" | "delete";
  path: string;
  /** Content to install; undefined for a delete. */
  content?: string;
  /** UTF-8 bytes retained by `content`; zero for a delete. */
  bytes: number;
  /**
   * Derived writes are journaled but record no revision.
   *
   * @remarks A derived write keeps its pre-image in the journal instead of in
   * history, so rollback stays exact without polluting the document's visible
   * revisions.
   */
  derived: boolean;
}

/**
 * What the batch engine needs from a backend.
 *
 * @remarks Deliberately tiny: read/write/delete/list against the tree, plus
 * the four journal steps and revision persistence. Everything else — ordering,
 * digesting, staging, rollback-on-throw — is decided here.
 */
export interface BatchPrimitives {
  readTree(relPath: string): Promise<string | null>;
  writeTree(relPath: string, content: string): Promise<void>;
  deleteTree(relPath: string): Promise<boolean>;
  listTree(): Promise<MemoryDoc[]>;
  /** Persist a revision's pre-image body and metadata, body first. */
  putRevision(revision: MemoryRevision, body: string): Promise<void>;
  /** The digest the last revision of this path installed, if any. */
  lastInstalledDigest(relPath: string): Promise<string | undefined>;
  /** Write the batch's intent durably. A no-op for a process-local backend. */
  writeJournal(record: MemoryJournalRecord): Promise<void>;
  /** Mark every tree write as landed — the point of no return. */
  markApplied(batchId: string): Promise<void>;
  /** Mark the batch complete. */
  markCommitted(batchId: string): Promise<void>;
  /** Drop the batch's journal directory. */
  sweepJournal(batchId: string): Promise<void>;
  /** Perform the batch's declared follow-up work. Must be idempotent. */
  runCommit(commit: MemoryBatchCommit): Promise<void>;
  /** Bounded history trim for the paths this batch touched. */
  pruneHistory(paths: string[]): Promise<void>;
  now(): number;
  newBatchId(): string;
}

/**
 * Run one recoverable batch.
 *
 * @param prims - the backend's primitives.
 * @param input - provenance and declared commit work.
 * @param fn - stages operations against the {@link MemoryBatch} handle.
 * @returns whatever `fn` returns.
 * @remarks Order is load-bearing:
 *
 * 1. run `fn`, staging only — the tree is untouched, so a throw here costs
 *    nothing and needs no rollback;
 * 2. capture each touched document's current body as a revision (additive, so
 *    a crash leaves only sweepable orphans);
 * 3. write the journal — the intent is now durable;
 * 4. apply every tree write;
 * 5. mark `applied` — past this point recovery rolls *forward*;
 * 6. run the declared commit work;
 * 7. mark `committed` and sweep;
 * 8. trim history for the touched paths.
 *
 * Staging is what makes step 3 possible: because nothing is applied until the
 * whole intent is known, the journal is written once and complete, rather than
 * being amended as the batch proceeds.
 *
 * The staged handle's `list` merges staged creations into the tree listing:
 * the deterministic reindex runs inside the batch and lists the tree to
 * decide what to link, so a leaf staged moments earlier would otherwise never
 * be wired into navigation. And a batch that stages nothing still runs its
 * declared commit work — the indexer's most common outcome is "this run
 * taught me nothing", and that run must still be marked indexed or every
 * later pass re-runs the model against it; with no tree mutation there is
 * nothing to roll back, so the journal is skipped in that case.
 */
export async function runBatch<T>(
  prims: BatchPrimitives,
  input: MemoryBatchInput,
  fn: (bx: MemoryBatch) => Promise<T>,
): Promise<T> {
  const batchId = prims.newBatchId();
  const staged = new Map<string, StagedOp>();
  let stagedBytes = 0;

  const handle: MemoryBatch = {
    id: batchId,
    async read(relPath) {
      const key = normalizeMemoryPath(relPath);
      const pending = staged.get(key);
      if (pending !== undefined) return pending.op === "delete" ? null : (pending.content ?? null);
      return prims.readTree(key);
    },
    async list() {
      const merged = new Map<string, MemoryDoc>();
      for (const doc of await prims.listTree()) merged.set(doc.path, doc);
      for (const op of staged.values()) {
        if (op.op === "delete") {
          merged.delete(op.path);
          continue;
        }
        const { frontmatter } = parseFrontmatter(op.content ?? "");
        merged.set(op.path, {
          path: op.path,
          kind: memoryDocKind(op.path),
          description: frontmatter.description,
          tags: frontmatter.tags,
          updated_at: prims.now(),
        });
      }
      return [...merged.values()].sort((a, b) => compareMemoryPaths(a.path, b.path));
    },
    async write(relPath, content, opts) {
      const key = normalizeMemoryPath(relPath);
      const bytes = assertMemoryPayloadBytes(
        "document",
        key,
        content,
        MEMORY_STORAGE_LIMITS.documentBytes,
      );
      if (!staged.has(key)) {
        assertMemoryStorageCount(
          "batch operations",
          batchId,
          staged.size + 1,
          MEMORY_STORAGE_LIMITS.batchOperations,
        );
      }
      const nextBytes = stagedBytes - (staged.get(key)?.bytes ?? 0) + bytes;
      assertMemoryStorageCount(
        "corpus",
        `batch:${batchId}`,
        nextBytes,
        MEMORY_STORAGE_LIMITS.corpusBytes,
      );
      staged.set(key, {
        op: "write",
        path: key,
        content,
        bytes,
        derived: opts?.derived === true,
      });
      stagedBytes = nextBytes;
      return Promise.resolve();
    },
    async delete(relPath) {
      const key = normalizeMemoryPath(relPath);
      const existed = (await handle.read(key)) !== null;
      if (!staged.has(key)) {
        assertMemoryStorageCount(
          "batch operations",
          batchId,
          staged.size + 1,
          MEMORY_STORAGE_LIMITS.batchOperations,
        );
      }
      stagedBytes -= staged.get(key)?.bytes ?? 0;
      staged.set(key, { op: "delete", path: key, bytes: 0, derived: false });
      return existed;
    },
  };

  const result = await fn(handle);
  if (staged.size === 0) {
    await prims.runCommit(input.commit ?? {});
    return result;
  }

  const at = prims.now();
  const ops: MemoryJournalOp[] = [];
  const revisions: { revision: MemoryRevision; body: string }[] = [];
  let retainedBytes = stagedBytes;

  for (const op of [...staged.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const before = await prims.readTree(op.path);
    const expected = before === null ? null : digestBody(before);
    const next = op.op === "delete" ? null : digestBody(op.content ?? "");

    if (expected === next && op.op === "write") continue;
    if (before === null && op.op === "delete") continue;

    if (before !== null) {
      retainedBytes += Buffer.byteLength(before, "utf8");
      assertMemoryStorageCount(
        "corpus",
        `batch:${batchId}`,
        retainedBytes,
        MEMORY_STORAGE_LIMITS.corpusBytes,
      );
    }

    let revisionId: string | null = null;
    if (!op.derived && before !== null && expected !== null) {
      const lastInstalled = await prims.lastInstalledDigest(op.path);
      const revision: MemoryRevision = {
        id: newRevisionId(at),
        path: op.path,
        at,
        op: op.op,
        ...(next !== null ? { digest: next } : {}),
        previous_digest: expected,
        bytes: Buffer.byteLength(before, "utf8"),
        source: input.source,
        batch_id: batchId,
        ...(lastInstalled !== undefined && lastInstalled !== expected
          ? { external_edit: true }
          : {}),
      };
      revisionId = revision.id;
      revisions.push({ revision, body: before });
    }
    ops.push({
      op: op.op,
      path: op.path,
      expected_digest: expected,
      next_digest: next,
      revision_id: revisionId,
      ...(revisionId === null && before !== null ? { previous_body: before } : {}),
    });
  }

  if (ops.length === 0) {
    await prims.runCommit(input.commit ?? {});
    return result;
  }

  const record: MemoryJournalRecord = {
    version: JOURNAL_VERSION,
    batch_id: batchId,
    at,
    source: input.source,
    ops,
    commit: input.commit ?? {},
  };
  assertMemoryPayloadBytes(
    "metadata",
    `journal:${batchId}`,
    JSON.stringify(record),
    MEMORY_STORAGE_LIMITS.metadataBytes,
  );

  // Validate the complete record before the first revision byte is persisted.
  for (const { revision, body } of revisions) await prims.putRevision(revision, body);
  await prims.writeJournal(record);

  for (const op of ops) {
    if (op.op === "delete") await prims.deleteTree(op.path);
    else await prims.writeTree(op.path, staged.get(op.path)?.content ?? "");
  }
  await prims.markApplied(batchId);

  await prims.runCommit(record.commit);
  await prims.markCommitted(batchId);
  await prims.sweepJournal(batchId);
  await prims.pruneHistory(ops.map((o) => o.path));

  return result;
}

/**
 * View a batch as the tree surface the deterministic reindex expects.
 *
 * @param bx - the batch to wrap.
 * @returns a read/write/list surface whose writes are marked derived.
 * @remarks Every caller that mutates through a batch also restitches
 * navigation inside it, and every one of those restitch writes is mechanical.
 * Routing them through one helper is what keeps link-block churn out of each
 * document's visible history while still journaling it for recovery.
 */
export function reindexView(bx: MemoryBatch): Pick<MemoryTx, "read" | "write" | "list"> {
  return {
    read: (relPath) => bx.read(relPath),
    write: (relPath, content) => bx.write(relPath, content, { derived: true }),
    list: () => bx.list(),
  };
}
