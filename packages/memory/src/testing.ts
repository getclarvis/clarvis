/**
 * Test support for {@link MemoryStore} implementations: an in-memory adapter and
 * the backend-agnostic contract every adapter must satisfy.
 *
 * The contract is exposed as **data** rather than as `describe`/`test` calls, and
 * asserts through `node:assert/strict`, so this module carries no test-runner
 * dependency and an adapter living in another package (or another runner) can
 * drive the same cases. See `tests/store.test.ts` for a driver.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { runBatch, type BatchPrimitives } from "./batch.ts";
import type { MemoryClock } from "./clock.ts";
import {
  appendAttempt,
  DEFAULT_MEMORY_JOB_PAGE_SIZE,
  isJobPrunable,
  keptFailureIds,
  type MemoryIndexJob,
  type MemoryJobState,
} from "./jobs.ts";
import { MEMORY_DEFAULTS } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { MemoryRecoveryReport } from "./journal.ts";
import { compareRevisionsNewestFirst, digestBody, type MemoryRevision } from "./revisions.ts";
import {
  compareMemoryPaths,
  memoryDocKind,
  normalizeMemoryPath,
  MemoryPathError,
} from "./paths.ts";
import { createGrepScanner, grepHitText } from "./text/grep.ts";
import {
  assertMemoryPayloadBytes,
  assertMemoryStorageCount,
  MEMORY_STORAGE_LIMITS,
} from "./storage-limits.ts";
import type {
  GrepHit,
  MemoryBatch,
  MemoryBatchInput,
  MemoryDoc,
  MemoryJobReader,
  MemoryJobTx,
  MemoryRevisionReader,
  RunSnapshot,
  MemoryStore,
  MemoryTx,
  MemoryUnitOfWork,
} from "./types.ts";

/** Options for {@link createInMemoryMemoryStore}. */
export interface CreateInMemoryStoreOptions {
  /** Injectable clock (epoch ms) stamped onto `MemoryDoc.updated_at` on write.
   * Defaults to a monotonic counter so ordering is deterministic in tests. */
  clock?: () => number;
}

/**
 * Build a process-local {@link MemoryStore} backed by a `Map`.
 *
 * @param opts - optional injectable clock; see {@link CreateInMemoryStoreOptions}.
 * @returns a store with the same observable contract as the file-backed adapter,
 *   for tests and for hosts that want an ephemeral tree.
 * @remarks `exclusive` provides mutual exclusion via a promise chain and, like
 *   the file adapter, **does not roll back** — a throw part-way leaves earlier
 *   writes applied.
 */
export function createInMemoryMemoryStore(opts: CreateInMemoryStoreOptions = {}): MemoryStore {
  /* eslint-disable @typescript-eslint/require-await -- every port method is
     async by contract (a path rejection must surface as a rejected promise,
     not a synchronous throw), but a Map-backed body has nothing to await. */
  let tick = 0;
  const clock = opts.clock ?? ((): number => ++tick);
  const docs = new Map<string, { content: string; updatedAt: number }>();
  const documentBytes = new Map<string, number>();
  let totalDocumentBytes = 0;
  const ledger = new Map<string, number>();
  const history = new Map<string, { revision: MemoryRevision; body: string }[]>();
  let totalHistoryBytes = 0;
  const jobs = new Map<string, MemoryIndexJob>();
  const jobBytes = new Map<string, number>();
  let totalJobBytes = 0;
  let batchSeq = 0;
  let leaseSeq = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const setJob = (key: string, job: MemoryIndexJob): void => {
    const bytes = assertMemoryPayloadBytes(
      "metadata",
      `job:${key}`,
      JSON.stringify(job),
      MEMORY_STORAGE_LIMITS.metadataBytes,
    );
    if (!jobs.has(key)) {
      assertMemoryStorageCount(
        "entries",
        "in-memory job store",
        jobs.size + 1,
        MEMORY_STORAGE_LIMITS.scanEntries,
      );
    }
    const nextTotal = totalJobBytes - (jobBytes.get(key) ?? 0) + bytes;
    assertMemoryStorageCount(
      "corpus",
      "in-memory job store",
      nextTotal,
      MEMORY_STORAGE_LIMITS.corpusBytes,
    );
    jobs.set(key, job);
    jobBytes.set(key, bytes);
    totalJobBytes = nextTotal;
  };

  const sorted = (): string[] => [...docs.keys()].sort(compareMemoryPaths);

  const tx: MemoryTx = {
    async read(relPath) {
      return docs.get(normalizeMemoryPath(relPath))?.content ?? null;
    },

    async readBounded(relPath, maxBytes) {
      const content = docs.get(normalizeMemoryPath(relPath))?.content;
      if (content === undefined) return null;
      const maximum = Math.max(
        0,
        Math.min(Math.trunc(maxBytes), MEMORY_STORAGE_LIMITS.documentBytes),
      );
      const bytes = Buffer.from(content, "utf8");
      if (bytes.length <= maximum) return { text: content, truncated: false };
      let end = maximum;
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
    },

    async write(relPath, content) {
      const key = normalizeMemoryPath(relPath);
      const bytes = assertMemoryPayloadBytes(
        "document",
        key,
        content,
        MEMORY_STORAGE_LIMITS.documentBytes,
      );
      if (!docs.has(key)) {
        assertMemoryStorageCount(
          "entries",
          "in-memory document store",
          docs.size + 1,
          MEMORY_STORAGE_LIMITS.scanEntries,
        );
      }
      const nextTotal = totalDocumentBytes - (documentBytes.get(key) ?? 0) + bytes;
      assertMemoryStorageCount(
        "corpus",
        "in-memory document store",
        nextTotal,
        MEMORY_STORAGE_LIMITS.corpusBytes,
      );
      docs.set(key, { content, updatedAt: clock() });
      documentBytes.set(key, bytes);
      totalDocumentBytes = nextTotal;
    },

    async delete(relPath) {
      const key = normalizeMemoryPath(relPath);
      const deleted = docs.delete(key);
      if (deleted) {
        totalDocumentBytes -= documentBytes.get(key) ?? 0;
        documentBytes.delete(key);
      }
      return deleted;
    },

    async list() {
      const out: MemoryDoc[] = [];
      let corpusBytes = 0;
      for (const rel of sorted()) {
        const entry = docs.get(rel);
        if (entry === undefined) continue;
        const bounded = await tx.readBounded?.(rel, MEMORY_STORAGE_LIMITS.prefixBytes);
        if (bounded === null || bounded === undefined) continue;
        const bytes = Buffer.byteLength(bounded.text, "utf8");
        if (corpusBytes + bytes > MEMORY_STORAGE_LIMITS.corpusBytes) break;
        corpusBytes += bytes;
        const { frontmatter } = parseFrontmatter(bounded.text);
        out.push({
          path: rel,
          kind: memoryDocKind(rel),
          description: frontmatter.description,
          tags: frontmatter.tags,
          updated_at: entry.updatedAt,
        });
      }
      return out;
    },

    async grep(query, grepOpts = {}) {
      const limit = grepOpts.limit ?? 20;
      const hits: GrepHit[] = [];
      const scanner = createGrepScanner(query, grepOpts);
      let corpusBytes = 0;
      for (const rel of sorted()) {
        if (!scanner.ok()) return hits;
        const content = docs.get(rel)?.content ?? "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (corpusBytes + bytes > MEMORY_STORAGE_LIMITS.corpusBytes) break;
        corpusBytes += bytes;
        let start = 0;
        let lineNumber = 0;
        while (start <= content.length) {
          if (!scanner.ok()) return hits;
          const end = content.indexOf("\n", start);
          const line = end < 0 ? content.slice(start) : content.slice(start, end);
          lineNumber += 1;
          if (scanner.match(line)) {
            hits.push({ path: rel, line: lineNumber, text: grepHitText(line) });
            if (hits.length >= limit) return hits;
          }
          if (end < 0) break;
          start = end + 1;
        }
      }
      return hits;
    },

    async wasIndexed(runId) {
      return ledger.has(runId);
    },

    async markIndexed(runId) {
      ledger.set(runId, clock());
    },

    async version() {
      const hash = createHash("sha256");
      let corpusBytes = 0;
      for (const rel of sorted()) {
        const content = docs.get(rel)?.content ?? "";
        const bytes = Buffer.byteLength(content, "utf8");
        hash.update(rel).update("\0").update(String(bytes)).update("\0");
        if (corpusBytes + bytes <= MEMORY_STORAGE_LIMITS.corpusBytes) {
          hash.update(content);
          corpusBytes += bytes;
        } else {
          hash.update("[content outside storage working set]");
        }
        hash.update("\0");
      }
      return hash.digest("hex");
    },
  };

  const revisions: MemoryRevisionReader = {
    async list(relPath) {
      const key = normalizeMemoryPath(relPath);
      return (history.get(key) ?? []).map((e) => e.revision).sort(compareRevisionsNewestFirst);
    },
    async read(relPath, revisionId) {
      const key = normalizeMemoryPath(relPath);
      return (history.get(key) ?? []).find((e) => e.revision.id === revisionId)?.body ?? null;
    },
  };

  const jobReader: MemoryJobReader = {
    async get(runId) {
      return jobs.get(runId) ?? null;
    },
    async list(query = {}) {
      const wanted =
        query.state === undefined
          ? null
          : new Set<MemoryJobState>(
              typeof query.state === "string" ? [query.state] : [...query.state],
            );
      const all = [...jobs.values()]
        .filter((j) => wanted === null || wanted.has(j.state))
        .sort((a, b) => b.enqueued_at - a.enqueued_at);
      return all.slice(
        0,
        Math.min(
          DEFAULT_MEMORY_JOB_PAGE_SIZE,
          Math.max(1, query.limit ?? DEFAULT_MEMORY_JOB_PAGE_SIZE),
        ),
      );
    },
    async counts() {
      const counts: Record<MemoryJobState, number> = {
        pending: 0,
        running: 0,
        retry_wait: 0,
        completed: 0,
        failed: 0,
      };
      for (const job of jobs.values()) counts[job.state] += 1;
      return counts;
    },
    async nextDueAt() {
      let earliest: number | undefined;
      for (const job of jobs.values()) {
        const due =
          job.state === "pending"
            ? job.enqueued_at
            : job.state === "retry_wait"
              ? job.not_before
              : job.state === "running"
                ? job.lease_until
                : undefined;
        if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
      }
      return earliest;
    },
  };

  const jobTx: MemoryJobTx = {
    ...jobReader,
    async enqueue(input) {
      const existing = jobs.get(input.run_id);
      if (existing !== undefined) return existing;
      const job: MemoryIndexJob = {
        run_id: input.run_id,
        agent_instance_id: randomUUID(),
        state: "pending",
        enqueued_at: input.at,
        updated_at: input.at,
        attempts: 0,
        snapshot: input.snapshot,
        ...(input.provider_key !== undefined ? { provider_key: input.provider_key } : {}),
        history: [],
      };
      setJob(job.run_id, job);
      return job;
    },
    async claim(now, lease) {
      const due = (job: MemoryIndexJob): boolean =>
        job.state === "pending" ||
        (job.state === "retry_wait" && (job.not_before ?? 0) <= now) ||
        (job.state === "running" && (job.lease_until ?? 0) <= now);
      const next = [...jobs.values()].filter(due).sort((a, b) => a.enqueued_at - b.enqueued_at)[0];
      if (next === undefined) return null;
      const claimed: MemoryIndexJob = {
        ...next,
        agent_instance_id: next.agent_instance_id ?? randomUUID(),
        indexer_execution_id: `exec_${randomUUID()}`,
        ...(next.indexer_execution_id === undefined
          ? {}
          : {
              indexer_continue_from: next.indexer_execution_id,
              indexer_prior_executions: [
                next.indexer_execution_id,
                ...(next.indexer_prior_executions ??
                  (next.indexer_continue_from ? [next.indexer_continue_from] : [])),
              ],
            }),
        state: "running",
        attempts: next.attempts + 1,
        updated_at: now,
        lease_until: now + lease.ms,
        lease_owner: lease.owner,
        lease_token: lease.token ?? `${lease.owner}:${String(++leaseSeq)}`,
      };
      delete claimed.not_before;
      setJob(claimed.run_id, claimed);
      return claimed;
    },
    async renew(runId, at, lease, ms) {
      const job = jobs.get(runId);
      if (
        job === undefined ||
        job.state !== "running" ||
        job.lease_owner !== lease.owner ||
        job.lease_token !== lease.token ||
        (job.lease_until ?? 0) <= at
      ) {
        return false;
      }
      setJob(runId, { ...job, updated_at: at, lease_until: at + ms });
      return true;
    },
    async refreshOwnedAfterFence(runId, at, lease, ms) {
      const job = jobs.get(runId);
      if (
        job === undefined ||
        job.state !== "running" ||
        job.lease_owner !== lease.owner ||
        job.lease_token !== lease.token
      ) {
        return false;
      }
      setJob(runId, { ...job, updated_at: at, lease_until: at + ms });
      return true;
    },
    async complete(runId, at, note, lease) {
      const job = jobs.get(runId);
      if (job === undefined) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const done: MemoryIndexJob = {
        ...job,
        state: "completed",
        updated_at: at,
        ...(note !== undefined ? { note } : {}),
      };
      delete done.snapshot;
      delete done.lease_until;
      delete done.lease_owner;
      delete done.lease_token;
      delete done.not_before;
      setJob(runId, done);
      return true;
    },
    async fail(runId, at, failure, next, lease) {
      const job = jobs.get(runId);
      if (job === undefined) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const updated: MemoryIndexJob = {
        ...job,
        state: next.state,
        updated_at: at,
        history: appendAttempt(job, failure, at),
        note: `${failure.phase}: ${failure.error}`.slice(0, 200),
      };
      delete updated.lease_until;
      delete updated.lease_owner;
      delete updated.lease_token;
      if (next.state === "retry_wait") updated.not_before = next.not_before;
      else delete updated.not_before;
      setJob(runId, updated);
      return true;
    },
    async release(runId, at, note, lease) {
      const job = jobs.get(runId);
      if (job === undefined) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const released: MemoryIndexJob = {
        ...job,
        state: "pending",
        attempts: Math.max(0, job.attempts - 1),
        updated_at: at,
        ...(note !== undefined ? { note } : {}),
      };
      delete released.lease_until;
      delete released.lease_owner;
      delete released.lease_token;
      delete released.not_before;
      setJob(runId, released);
      return true;
    },
    async retry(runId, at) {
      const job = jobs.get(runId);
      if (job === undefined || job.state !== "failed") return null;
      const revived: MemoryIndexJob = {
        ...job,
        state: "pending",
        attempts: 0,
        updated_at: at,
        note: "retried by operator",
      };
      delete revived.not_before;
      delete revived.lease_until;
      delete revived.lease_owner;
      delete revived.lease_token;
      setJob(runId, revived);
      return revived;
    },
    async prune(opts) {
      const all = [...jobs.values()].sort((a, b) => b.updated_at - a.updated_at);
      const keep = keptFailureIds(all, opts.keepFailed);
      let removed = 0;
      for (const job of all) {
        if (keep.has(job.run_id)) continue;
        if (!isJobPrunable(job, opts)) continue;
        jobs.delete(job.run_id);
        totalJobBytes -= jobBytes.get(job.run_id) ?? 0;
        jobBytes.delete(job.run_id);
        removed += 1;
      }
      return removed;
    },
  };

  /**
   * Batch primitives over the Map backend.
   *
   * @remarks The journal steps are deliberately no-ops. A journal exists so a
   * batch can be finished or undone by a *later process*; this store cannot
   * outlive its process, so there is nothing to recover to. All-or-nothing
   * behaviour still holds, because the engine stages every operation and
   * applies them only after the batch body returns.
   */
  function batchPrimitives(): BatchPrimitives {
    return {
      readTree: (relPath) => tx.read(relPath),
      writeTree: (relPath, content) => tx.write(relPath, content),
      deleteTree: (relPath) => tx.delete(relPath),
      listTree: () => tx.list(),
      async putRevision(revision, body) {
        const bytes = assertMemoryPayloadBytes(
          "revision body",
          `${revision.path}@${revision.id}`,
          body,
          MEMORY_STORAGE_LIMITS.revisionBodyBytes,
        );
        assertMemoryStorageCount(
          "corpus",
          "in-memory revision store",
          totalHistoryBytes + bytes,
          MEMORY_STORAGE_LIMITS.corpusBytes,
        );
        const entries = history.get(revision.path) ?? [];
        entries.push({ revision, body });
        history.set(revision.path, entries);
        totalHistoryBytes += bytes;
      },
      async lastInstalledDigest(relPath) {
        return (await revisions.list(relPath))[0]?.digest;
      },
      async writeJournal() {
        /* process-local: nothing outlives this store to replay a journal */
      },
      async markApplied() {
        /* see writeJournal */
      },
      async markCommitted() {
        /* see writeJournal */
      },
      async sweepJournal() {
        /* see writeJournal */
      },
      async runCommit(commit) {
        if (commit.mark_indexed !== undefined) await tx.markIndexed(commit.mark_indexed);
      },
      async pruneHistory(paths) {
        const policy = MEMORY_DEFAULTS.history;
        for (const p of paths) {
          const entries = (history.get(p) ?? [])
            .slice()
            .sort((a, b) => compareRevisionsNewestFirst(a.revision, b.revision));
          if (entries.length > policy.keep_revisions) {
            const kept = entries.slice(0, policy.keep_revisions);
            const removed = entries.slice(policy.keep_revisions);
            for (const entry of removed) {
              totalHistoryBytes -= Buffer.byteLength(entry.body, "utf8");
            }
            history.set(p, kept);
          }
        }
      },
      now: clock,
      newBatchId: () => `mem-${String(++batchSeq)}`,
    };
  }

  const unitOfWork: MemoryUnitOfWork = {
    ...tx,
    revisions,
    jobs: jobTx,
    batch<T>(input: MemoryBatchInput, fn: (bx: MemoryBatch) => Promise<T>): Promise<T> {
      return runBatch(batchPrimitives(), input, fn);
    },
  };

  return {
    ...tx,
    revisions,
    jobs: jobReader,
    async recover(): Promise<MemoryRecoveryReport> {
      return { entries: [], required: false };
    },
    exclusive(fn) {
      const run = tail.then(
        () => fn(unitOfWork),
        () => fn(unitOfWork),
      );
      tail = run.catch(() => undefined);
      return run;
    },
  };
  /* eslint-enable @typescript-eslint/require-await */
}

/** What a {@link ConformanceCase} needs from the adapter under test. */
export interface MemoryStoreHarness {
  /** The adapter instance, freshly constructed and empty. */
  store: MemoryStore;
  /**
   * Write raw content at `relPath` behind the store's back, as a human editing
   * the tree would. Adapters that cannot be edited out of band omit it, and the
   * cases that need it skip.
   */
  poke?: (relPath: string, content: string) => Promise<void>;
  /** Release whatever the harness allocated. */
  cleanup: () => Promise<void>;
}

/** One backend-agnostic contract case. */
export interface ConformanceCase {
  /** Test name, unique within the suite. */
  name: string;
  /** Runs the case, throwing on failure. */
  run: (harness: MemoryStoreHarness) => Promise<void>;
}

const DOC = "---\ndescription: bun facts\ntags: [bun]\n---\nBun is pinned to 1.3.14 via mise\n";
const LEAF = "infra/bun/MEMORY.md";

function conformanceRun(runId: string): RunSnapshot {
  return {
    run_id: runId,
    workspace: "/workspace",
    status: "completed",
    started_at: 1,
    ended_at: 2,
    task: "exercise the store contract",
    tool_calls: [],
  };
}

/**
 * The contract every {@link MemoryStore} adapter must satisfy.
 *
 * @returns the cases, in a stable order. A driver runs each against a freshly
 *   built {@link MemoryStoreHarness}; a case needing a capability the harness
 *   lacks (`poke`) returns early rather than failing.
 */
export function memoryStoreConformance(): readonly ConformanceCase[] {
  return [
    {
      name: "writes then reads a document, creating intermediate levels",
      async run({ store }) {
        await store.write("infra/bun/MEMORY.md", DOC);
        assert.equal(await store.read("infra/bun/MEMORY.md"), DOC);
      },
    },
    {
      name: "reports an absent document as null and delete as false",
      async run({ store }) {
        assert.equal(await store.read("nope/MEMORY.md"), null);
        assert.equal(await store.delete("nope/MEMORY.md"), false);
        await store.write("a/b/MEMORY.md", DOC);
        assert.equal(await store.delete("a/b/MEMORY.md"), true);
        assert.equal(await store.read("a/b/MEMORY.md"), null);
      },
    },
    {
      name: "derives kind, description and tags in list, sorted by path",
      async run({ store }) {
        await store.write("PROFILE.md", "---\ndescription: root\n---\nbody\n");
        await store.write("infra/TOPIC.md", "---\ndescription: infra\n---\nbody\n");
        await store.write("infra/bun/MEMORY.md", DOC);
        const docs = await store.list();
        assert.deepEqual(
          docs.map((d) => d.path),
          ["PROFILE.md", "infra/TOPIC.md", "infra/bun/MEMORY.md"],
        );
        assert.deepEqual(
          docs.map((d) => d.kind),
          ["profile", "topic", "memory"],
        );
        const leaf = docs.find((d) => d.kind === "memory");
        assert.equal(leaf?.description, "bun facts");
        assert.deepEqual(leaf?.tags, ["bun"]);
      },
    },
    {
      name: "normalizes equivalent keys to the same document",
      async run({ store }) {
        await store.write("infra/bun/MEMORY.md", DOC);
        assert.equal(await store.read("./infra/bun/MEMORY.md"), DOC);
        assert.equal(await store.read("infra//bun/MEMORY.md"), DOC);
        assert.equal(await store.read("infra\\bun\\MEMORY.md"), DOC);
        assert.equal((await store.list()).length, 1);
      },
    },
    {
      name: "rejects traversal, absolute and non-markdown keys with a typed error",
      async run({ store }) {
        for (const bad of ["../escape.md", "/etc/passwd.md", "a/b.txt"]) {
          await assert.rejects(
            () => store.write(bad, "x"),
            (err: unknown) => err instanceof MemoryPathError && err.code === "memory_path_invalid",
            `expected ${bad} to be rejected`,
          );
        }
      },
    },
    {
      name: "greps keywords, reporting path and 1-based line",
      async run({ store }) {
        await store.write("infra/bun/MEMORY.md", DOC);
        const hits = await store.grep("mise pinned");
        assert.equal(hits.length, 1);
        assert.equal(hits[0]?.path, "infra/bun/MEMORY.md");
        assert.equal(hits[0]?.line, 5);
        assert.ok(hits[0]?.text.includes("mise"));
      },
    },
    {
      name: "greps by regex and degrades to keywords on an unusable pattern",
      async run({ store }) {
        await store.write("a/b/MEMORY.md", "---\ndescription: d\n---\nerror code E2345 here\n");
        assert.ok((await store.grep("E\\d+", { regex: true }))[0]?.text.includes("E2345"));
        assert.deepEqual(await store.grep("(unclosed", { regex: true }), []);
      },
    },
    {
      name: "honours the grep limit",
      async run({ store }) {
        await store.write("a/b/MEMORY.md", "---\ndescription: d\n---\nmise\nmise\nmise\n");
        assert.equal((await store.grep("mise", { limit: 2 })).length, 2);
      },
    },
    {
      name: "serializes concurrent exclusive sections",
      async run({ store }) {
        const order: string[] = [];
        const critical = (tag: string): Promise<void> =>
          store.exclusive(async () => {
            order.push(`${tag}:start`);
            await new Promise((r) => setTimeout(r, 20));
            order.push(`${tag}:end`);
          });
        await Promise.all([critical("a"), critical("b")]);
        assert.match(order[1] ?? "", /:end$/);
        assert.equal(order.filter((o) => o.endsWith(":start")).length, 2);
      },
    },
    {
      name: "makes writes through the exclusive handle visible on the store",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.write("a/b/MEMORY.md", DOC);
        });
        assert.equal(await store.read("a/b/MEMORY.md"), DOC);
      },
    },
    {
      name: "records a run in the ledger at most once",
      async run({ store }) {
        assert.equal(await store.wasIndexed("run-1"), false);
        await store.markIndexed("run-1");
        assert.equal(await store.wasIndexed("run-1"), true);
        assert.equal(await store.wasIndexed("run-2"), false);
        await store.markIndexed("run-1");
        assert.equal(await store.wasIndexed("run-1"), true);
      },
    },
    {
      name: "keeps the ledger out of the document listing",
      async run({ store }) {
        await store.write("a/b/MEMORY.md", DOC);
        await store.markIndexed("run-1");
        assert.deepEqual(
          (await store.list()).map((d) => d.path),
          ["a/b/MEMORY.md"],
        );
      },
    },
    {
      name: "enqueues each run once and reports queue counts",
      async run({ store }) {
        const input = { run_id: "r1", snapshot: conformanceRun("r1"), at: 10 };
        const first = await store.exclusive((tx) => tx.jobs.enqueue(input));
        const second = await store.exclusive((tx) => tx.jobs.enqueue({ ...input, at: 20 }));
        assert.equal(second.enqueued_at, first.enqueued_at);
        assert.equal((await store.jobs.list()).length, 1);
        assert.equal((await store.jobs.counts()).pending, 1);
      },
    },
    {
      name: "claims a due job once and refunds an interrupted attempt on release",
      async run({ store }) {
        await store.exclusive((tx) =>
          tx.jobs.enqueue({ run_id: "r1", snapshot: conformanceRun("r1"), at: 1 }),
        );
        await store.exclusive(async (tx) => {
          const claimed = await tx.jobs.claim(1, { ms: 100, owner: "worker-1" });
          assert.equal(claimed?.state, "running");
          assert.equal(claimed?.attempts, 1);
          assert.equal(await tx.jobs.claim(2, { ms: 100, owner: "worker-2" }), null);
          await tx.jobs.release("r1", 3, "shutting down", {
            owner: "worker-1",
            token: claimed?.lease_token ?? "missing-claim-token",
          });
        });
        const released = await store.jobs.get("r1");
        assert.equal(released?.state, "pending");
        assert.equal(released?.attempts, 0);
      },
    },
    {
      name: "reclaims an expired lease without losing the prior attempt",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.jobs.enqueue({ run_id: "r1", snapshot: conformanceRun("r1"), at: 1 });
          await tx.jobs.claim(1, { ms: 10, owner: "dead-worker" });
          const reclaimed = await tx.jobs.claim(20, { ms: 10, owner: "worker-2" });
          assert.equal(reclaimed?.lease_owner, "worker-2");
          assert.equal(reclaimed?.attempts, 2);
        });
      },
    },
    {
      name: "refreshes a fenced long effect and rejects every stale operation after reclaim",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.jobs.enqueue({ run_id: "r1", snapshot: conformanceRun("r1"), at: 1 });
          const first = await tx.jobs.claim(1, {
            ms: 10,
            owner: "worker-1",
            token: "claim-1",
          });
          assert.equal(
            await tx.jobs.renew("r1", 5, { owner: "worker-1", token: "claim-1" }, 10),
            true,
          );
          assert.equal((await tx.jobs.get("r1"))?.lease_until, 15);
          assert.equal(
            await tx.jobs.refreshOwnedAfterFence(
              "r1",
              20,
              { owner: "worker-1", token: "claim-1" },
              10,
            ),
            true,
          );
          assert.equal((await tx.jobs.get("r1"))?.lease_until, 30);

          const second = await tx.jobs.claim(31, {
            ms: 100,
            owner: "worker-2",
            token: "claim-2",
          });
          assert.equal(second?.attempts, 2);
          assert.equal(await tx.jobs.complete("r1", 32), false);
          assert.equal(
            await tx.jobs.fail(
              "r1",
              32,
              { phase: "apply", error: "unfenced" },
              { state: "failed" },
            ),
            false,
          );
          assert.equal(await tx.jobs.release("r1", 32), false);
          const stale = { owner: "worker-1", token: first?.lease_token ?? "claim-1" };
          assert.equal(await tx.jobs.renew("r1", 32, stale, 10), false);
          assert.equal(await tx.jobs.refreshOwnedAfterFence("r1", 32, stale, 10), false);
          assert.equal(await tx.jobs.complete("r1", 32, undefined, stale), false);
          assert.equal(
            await tx.jobs.fail(
              "r1",
              32,
              { phase: "apply", error: "stale" },
              { state: "failed" },
              stale,
            ),
            false,
          );
          assert.equal(await tx.jobs.release("r1", 32, undefined, stale), false);
          assert.equal((await tx.jobs.get("r1"))?.lease_owner, "worker-2");
          assert.equal(
            await tx.jobs.complete("r1", 33, undefined, {
              owner: "worker-2",
              token: second?.lease_token ?? "claim-2",
            }),
            true,
          );
        });
      },
    },
    {
      name: "does not let an expired worker renew or settle before reclaim",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.jobs.enqueue({ run_id: "r1", snapshot: conformanceRun("r1"), at: 1 });
          const claimed = await tx.jobs.claim(1, {
            ms: 10,
            owner: "late-worker",
            token: "late-claim",
          });
          const lease = {
            owner: "late-worker",
            token: claimed?.lease_token ?? "late-claim",
          };
          assert.equal(await tx.jobs.renew("r1", 12, lease, 10), false);
          assert.equal(await tx.jobs.complete("r1", 12, undefined, lease), false);
          assert.equal(
            await tx.jobs.fail(
              "r1",
              12,
              { phase: "apply", error: "late" },
              { state: "failed" },
              lease,
            ),
            false,
          );
          assert.equal(await tx.jobs.release("r1", 12, undefined, lease), false);
          assert.equal((await tx.jobs.get("r1"))?.state, "running");
        });
      },
    },
    {
      name: "only retry revives a failed job and retains its evidence",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.jobs.enqueue({ run_id: "r1", snapshot: conformanceRun("r1"), at: 1 });
          const claimed = await tx.jobs.claim(1, { ms: 10, owner: "worker" });
          await tx.jobs.fail(
            "r1",
            2,
            { phase: "generate", error: "provider down" },
            { state: "failed" },
            { owner: "worker", token: claimed?.lease_token ?? "missing-claim-token" },
          );
          assert.equal(await tx.jobs.retry("unknown", 3), null);
          const revived = await tx.jobs.retry("r1", 3);
          assert.equal(revived?.state, "pending");
          assert.equal(revived?.attempts, 0);
          assert.match(revived?.history[0]?.error ?? "", /provider down/);
        });
      },
    },
    {
      name: "prunes only eligible terminal or explicitly stale pending jobs",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          for (const runId of ["done", "failed"]) {
            await tx.jobs.enqueue({ run_id: runId, snapshot: conformanceRun(runId), at: 0 });
          }
          await tx.jobs.complete("done", 0);
          const failedClaim = await tx.jobs.claim(0, { ms: 1, owner: "worker" });
          await tx.jobs.fail(
            "failed",
            0,
            { phase: "apply", error: "x" },
            { state: "failed" },
            { owner: "worker", token: failedClaim?.lease_token ?? "missing-claim-token" },
          );
          await tx.jobs.enqueue({ run_id: "held", snapshot: conformanceRun("held"), at: 0 });
          await tx.jobs.claim(0, { ms: 60_000, owner: "worker" });
          await tx.jobs.enqueue({ run_id: "waiting", snapshot: conformanceRun("waiting"), at: 0 });

          assert.equal(await tx.jobs.prune({ terminalBefore: 1_000, keepFailed: 5 }), 1);
          assert.equal((await tx.jobs.get("failed"))?.state, "failed");
          assert.equal((await tx.jobs.get("waiting"))?.state, "pending");
          assert.equal((await tx.jobs.get("held"))?.state, "running");
          assert.equal(
            await tx.jobs.prune({
              terminalBefore: 1_000,
              pendingBefore: 1_000,
              keepFailed: 5,
            }),
            1,
          );
          assert.equal(await tx.jobs.get("waiting"), null);
          assert.equal((await tx.jobs.get("held"))?.state, "running");
        });
      },
    },
    {
      name: "filters and limits job views and reports the earliest due work",
      async run({ store }) {
        await store.exclusive(async (tx) => {
          await tx.jobs.enqueue({ run_id: "running", snapshot: conformanceRun("running"), at: 1 });
          await tx.jobs.claim(1, { ms: 100, owner: "worker" });
          await tx.jobs.enqueue({ run_id: "retry", snapshot: conformanceRun("retry"), at: 2 });
          const retryClaim = await tx.jobs.claim(2, { ms: 100, owner: "worker" });
          await tx.jobs.fail(
            "retry",
            2,
            { phase: "generate", error: "transient" },
            { state: "retry_wait", not_before: 50 },
            { owner: "worker", token: retryClaim?.lease_token ?? "missing-claim-token" },
          );
          await tx.jobs.enqueue({ run_id: "pending", snapshot: conformanceRun("pending"), at: 3 });
        });

        assert.deepEqual(
          (await store.jobs.list({ state: "running" })).map((job) => job.run_id),
          ["running"],
        );
        assert.deepEqual(
          (await store.jobs.list({ state: ["pending", "retry_wait"], limit: 1 })).map(
            (job) => job.run_id,
          ),
          ["pending"],
        );
        assert.deepEqual(await store.jobs.counts(), {
          pending: 1,
          running: 1,
          retry_wait: 1,
          completed: 0,
          failed: 0,
        });
        assert.equal(await store.jobs.nextDueAt(), 3);
      },
    },
    {
      name: "reports a stable version that changes with any document change",
      async run({ store }) {
        const empty = await store.version();
        assert.equal(await store.version(), empty);
        await store.write("a/b/MEMORY.md", DOC);
        const written = await store.version();
        assert.notEqual(written, empty);
        assert.equal(await store.version(), written);
        await store.write("a/b/MEMORY.md", `${DOC}more\n`);
        assert.notEqual(await store.version(), written);
        await store.delete("a/b/MEMORY.md");
        assert.equal(await store.version(), empty);
      },
    },
    {
      name: "reads a document edited behind the store's back",
      async run({ store, poke }) {
        if (poke === undefined) return;
        await store.write("a/b/MEMORY.md", DOC);
        await poke("a/b/MEMORY.md", "---\ndescription: edited by hand\n---\nnew body\n");
        assert.equal((await store.list())[0]?.description, "edited by hand");
        assert.ok((await store.read("a/b/MEMORY.md"))?.includes("new body"));
      },
    },
    {
      name: "applies a batch all at once, or not at all when its body throws",
      async run({ store }) {
        await store.write("a/b/MEMORY.md", DOC);
        const before = await store.version();
        await assert.rejects(() =>
          store.exclusive((tx) =>
            tx.batch({ source: { kind: "tool", tool: "write_memory" } }, async (bx) => {
              await bx.write("a/b/MEMORY.md", "---\ndescription: replaced\n---\nnew\n");
              await bx.write("c/d/MEMORY.md", DOC);
              throw new Error("boom");
            }),
          ),
        );
        assert.equal(await store.read("a/b/MEMORY.md"), DOC);
        assert.equal(await store.read("c/d/MEMORY.md"), null);
        assert.equal(await store.version(), before);
      },
    },
    {
      name: "makes a batch's staged documents visible to reads inside the batch",
      async run({ store }) {
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "write_memory" } }, async (bx) => {
            await bx.write("a/b/MEMORY.md", DOC);
            assert.equal(await bx.read("a/b/MEMORY.md"), DOC);
            assert.ok((await bx.list()).some((d) => d.path === "a/b/MEMORY.md"));
          }),
        );
        assert.equal(await store.read("a/b/MEMORY.md"), DOC);
      },
    },
    {
      name: "records exact replacement bytes, metadata and tool provenance",
      async run({ store }) {
        const replaced = "---\ndescription: second\n---\nsecond\n";
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
            bx.write("a/b/MEMORY.md", DOC),
          ),
        );
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
            bx.write("a/b/MEMORY.md", replaced),
          ),
        );

        const revs = await store.revisions.list("a/b/MEMORY.md");
        assert.equal(revs.length, 1);
        assert.equal(revs[0]?.op, "write");
        assert.equal(revs[0]?.path, "a/b/MEMORY.md");
        assert.equal(revs[0]?.previous_digest, digestBody(DOC));
        assert.equal(revs[0]?.digest, digestBody(replaced));
        assert.deepEqual(revs[0]?.source, { kind: "tool", tool: "write_memory" });
        assert.equal(await store.revisions.read("a/b/MEMORY.md", revs[0].id), DOC);
        assert.equal(await store.read("a/b/MEMORY.md"), replaced);
      },
    },
    {
      name: "records no revision for a document's first creation",
      async run({ store }) {
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) => bx.write(LEAF, DOC)),
        );
        assert.deepEqual(await store.revisions.list(LEAF), []);
      },
    },
    {
      name: "orders replacement history newest first",
      async run({ store }) {
        for (const body of ["v1", "v2", "v3"]) {
          await store.exclusive((tx) =>
            tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
              bx.write(LEAF, `---\ndescription: bun facts\n---\n${body}\n`),
            ),
          );
        }
        const revs = await store.revisions.list(LEAF);
        assert.equal(revs.length, 2);
        assert.match((await store.revisions.read(LEAF, revs[0]!.id)) ?? "", /v2/);
        assert.match((await store.revisions.read(LEAF, revs[1]!.id)) ?? "", /v1/);
      },
    },
    {
      name: "keeps a deleted document's body as a reversible revision",
      async run({ store }) {
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) => bx.write(LEAF, DOC)),
        );
        await store.exclusive((tx) =>
          tx.batch({ source: { kind: "tool", tool: "delete_memory" } }, (bx) => bx.delete(LEAF)),
        );
        const revision = (await store.revisions.list(LEAF))[0];
        assert.equal(revision?.op, "delete");
        assert.equal(revision?.digest, undefined);
        assert.equal(await store.revisions.read(LEAF, revision.id), DOC);
      },
    },
    {
      name: "flags a revision whose predecessor was edited outside the store",
      async run({ store, poke }) {
        if (poke === undefined) return;
        const replace = async (content: string): Promise<void> =>
          store.exclusive((tx) =>
            tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
              bx.write(LEAF, content),
            ),
          );
        await replace(DOC);
        await replace(`${DOC}second\n`);
        await poke(LEAF, `${DOC}edited by hand\n`);
        await replace(`${DOC}third\n`);
        const revisions = await store.revisions.list(LEAF);
        assert.equal(revisions[0]?.external_edit, true);
        assert.equal(revisions[1]?.external_edit, undefined);
      },
    },
    {
      name: "runs a batch's declared commit work even when it changes nothing",
      async run({ store }) {
        await store.exclusive((tx) =>
          tx.batch(
            { source: { kind: "indexer", run_id: "r1" }, commit: { mark_indexed: "r1" } },
            async () => {
              /* the common case: the run taught us nothing */
            },
          ),
        );
        assert.equal(await store.wasIndexed("r1"), true);
      },
    },
    {
      name: "reports a clean recovery pass on an untouched tree",
      async run({ store }) {
        await store.write("a/b/MEMORY.md", DOC);
        const report = await store.recover();
        assert.equal(report.required, false);
        assert.deepEqual(await store.recover(), report);
        assert.equal(await store.read("a/b/MEMORY.md"), DOC);
      },
    },
  ];
}

/** A {@link MemoryClock} whose time only moves when a test moves it. */
export interface TestClock extends MemoryClock {
  /**
   * Advance virtual time, firing every timer that comes due.
   *
   * @param ms - how far to move.
   * @remarks Flushes the microtask queue between timers, so work a fired
   *   callback awaits settles before the next one runs — otherwise a chain of
   *   scheduled passes would appear not to happen.
   */
  advance(ms: number): Promise<void>;
  /** Timers still armed, so a test can assert the worker rescheduled itself. */
  pending(): number;
}

/**
 * Build a controllable clock.
 *
 * @param start - the initial epoch ms.
 * @returns a {@link TestClock}; no real timer is ever created.
 */
export function createTestClock(start = 1_700_000_000_000): TestClock {
  let current = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    after(ms, fn) {
      const id = ++seq;
      timers.set(id, { at: current + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        current = Math.max(current, timer.at);
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}
