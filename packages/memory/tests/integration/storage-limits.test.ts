import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { readUtf8FileBounded, scanDirectoryBounded } from "../../src/bounded-io.ts";
import { createFileMemoryStore } from "../../src/file-store.ts";
import { createDocumentRepository } from "../../src/file-store/documents.ts";
import { encodeRunId, createJobRepository } from "../../src/file-store/jobs.ts";
import { createJournalRepository } from "../../src/file-store/journal.ts";
import { createRevisionRepository } from "../../src/file-store/revisions.ts";
import { health } from "../../src/health.ts";
import type { MemoryJournalRecord } from "../../src/journal.ts";
import { loadMemoryPolicy } from "../../src/recording-policy.ts";
import { MEMORY_STORAGE_LIMITS, MemoryStorageLimitError } from "../../src/storage-limits.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { makeRoot } from "../helpers/fs.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root() {
  const made = await makeRoot();
  cleanups.push(made.cleanup);
  const init = async (): Promise<void> => {
    await fs.mkdir(made.root, { recursive: true, mode: 0o700 });
  };
  return { ...made, init };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function journalRecord(batchId = "batch-1"): MemoryJournalRecord {
  return {
    version: 1,
    batch_id: batchId,
    at: 1,
    source: { kind: "tool", tool: "test" },
    ops: [],
    commit: {},
  };
}

describe("memory storage working-set limits", () => {
  test("a sparse oversized document is explicit on direct read and skipped by scans", async () => {
    const made = await root();
    const documents = createDocumentRepository({
      root: made.root,
      init: made.init,
      clock: () => 1,
    });
    const file = path.join(made.root, "huge.md");
    await fs.writeFile(file, "---\ndescription: huge\n---\nneedle\n");
    await fs.truncate(file, MEMORY_STORAGE_LIMITS.documentBytes + 1);

    await expect(documents.read("huge.md")).rejects.toMatchObject({
      code: "memory_storage_limit",
      kind: "document",
      maximum: MEMORY_STORAGE_LIMITS.documentBytes,
    });
    await expect(documents.readBounded!("huge.md", 32)).resolves.toMatchObject({
      truncated: true,
    });
    await expect(documents.grep("needle")).resolves.toEqual([]);
    await expect(documents.list()).resolves.toHaveLength(1);
  });

  test("document writes refuse an oversized body before creating or replacing a file", async () => {
    const made = await root();
    const store = createFileMemoryStore({ root: made.root });
    const oversized = "x".repeat(MEMORY_STORAGE_LIMITS.documentBytes + 1);

    await expect(store.write("new.md", oversized)).rejects.toBeInstanceOf(MemoryStorageLimitError);
    expect(await exists(path.join(made.root, "new.md"))).toBe(false);

    await store.write("kept.md", "small");
    await expect(store.write("kept.md", oversized)).rejects.toBeInstanceOf(MemoryStorageLimitError);
    expect(await fs.readFile(path.join(made.root, "kept.md"), "utf8")).toBe("small");
  });

  test("a batch cannot delete an out-of-band oversized document or start a journal", async () => {
    const made = await root();
    const file = path.join(made.root, "protected.md");
    await fs.writeFile(file, "protected");
    await fs.truncate(file, MEMORY_STORAGE_LIMITS.documentBytes + 1);
    const store = createFileMemoryStore({ root: made.root });

    await expect(
      store.exclusive((tx) =>
        tx.batch({ source: { kind: "tool", tool: "delete_memory" } }, async (batch) => {
          await batch.delete("protected.md");
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryStorageLimitError);

    expect((await fs.stat(file)).size).toBe(MEMORY_STORAGE_LIMITS.documentBytes + 1);
    expect(await exists(path.join(made.root, ".journal"))).toBe(false);
  });

  test("descriptor-backed reads detect growth after stat without following it", async () => {
    const made = await root();
    const file = path.join(made.root, "growing.md");
    await fs.writeFile(file, "abc");

    await expect(
      readUtf8FileBounded(file, {
        maxBytes: 4,
        kind: "document",
        afterStat: () => fs.appendFile(file, "0123456789"),
      }),
    ).rejects.toMatchObject({ code: "memory_storage_limit", maximum: 4 });

    const prefix = await readUtf8FileBounded(file, {
      maxBytes: 4,
      kind: "document",
      truncate: true,
    });
    expect(prefix).toEqual({ text: "abc0", bytes: 4, truncated: true });
  });

  test("descriptor-backed reads reject in-budget changes and non-files", async () => {
    const made = await root();
    const file = path.join(made.root, "changing.md");
    await fs.writeFile(file, "abc");

    await expect(
      readUtf8FileBounded(file, {
        maxBytes: 10,
        kind: "document",
        afterStat: () => fs.appendFile(file, "d"),
      }),
    ).rejects.toThrow(/changed while it was being read/);
    await expect(
      readUtf8FileBounded(made.root, { maxBytes: 10, kind: "document" }),
    ).rejects.toMatchObject({ name: "MemoryStorageReadError" });
  });

  test("directory iteration proves truncation with only one look-ahead entry", async () => {
    const made = await root();
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(path.join(made.root, `${String(index)}.json`), "{}");
    }
    const visited: string[] = [];

    const scan = await scanDirectoryBounded(made.root, 3, (entry) => {
      visited.push(entry.name);
    });

    expect(scan).toEqual({ inspected: 4, truncated: true });
    expect(visited).toHaveLength(3);
  });

  test("an exact document scan boundary drains an empty pending subtree", async () => {
    const made = await root();
    await fs.mkdir(path.join(made.root, "empty"));
    await fs.writeFile(
      path.join(made.root, "root.md"),
      "---\ndescription: root\n---\nexact boundary\n",
    );
    const documents = createDocumentRepository({
      root: made.root,
      init: made.init,
      clock: () => 1,
      scanEntries: 2,
    });

    await expect(documents.list()).resolves.toMatchObject([{ path: "root.md" }]);
    await expect(documents.grep("exact boundary")).resolves.toMatchObject([
      { path: "root.md", line: 4 },
    ]);
    await expect(documents.version()).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  test("list and grep reject a non-empty subtree beyond the exact scan boundary", async () => {
    const made = await root();
    await fs.mkdir(path.join(made.root, "pending"));
    await fs.writeFile(
      path.join(made.root, "pending", "MEMORY.md"),
      "---\ndescription: pending\n---\nhidden needle\n",
    );
    await fs.writeFile(
      path.join(made.root, "root.md"),
      "---\ndescription: root\n---\nvisible needle\n",
    );
    const documents = createDocumentRepository({
      root: made.root,
      init: made.init,
      clock: () => 1,
      scanEntries: 2,
    });
    const expected = {
      code: "memory_storage_limit",
      kind: "entries",
      actual: 3,
      maximum: 2,
    };

    await expect(documents.list()).rejects.toMatchObject(expected);
    await expect(documents.grep("needle")).rejects.toMatchObject(expected);
    await expect(documents.version()).rejects.toMatchObject(expected);
  });

  test("catalog operations accept the exact corpus boundary and reject one byte beyond it", async () => {
    const made = await root();
    await fs.writeFile(path.join(made.root, "a.md"), "needle\n");
    const documents = createDocumentRepository({
      root: made.root,
      init: made.init,
      clock: () => 1,
      corpusBytes: 7,
    });

    await expect(documents.list()).resolves.toMatchObject([{ path: "a.md" }]);
    await expect(documents.grep("needle")).resolves.toMatchObject([
      { path: "a.md", line: 1, text: "needle" },
    ]);
    await expect(documents.version()).resolves.toMatch(/^[a-f0-9]{64}$/);

    await fs.writeFile(path.join(made.root, "b.md"), "x");
    const expected = {
      code: "memory_storage_limit",
      kind: "corpus",
      actual: 8,
      maximum: 7,
    };
    await expect(documents.list()).rejects.toMatchObject(expected);
    await expect(documents.grep("absent")).rejects.toMatchObject(expected);
    await expect(documents.version()).rejects.toMatchObject(expected);
  });

  test("oversized revision bodies and job records are never materialized", async () => {
    const made = await root();
    const revisions = createRevisionRepository({ machineryRoot: made.root, init: made.init });
    const revisionDir = path.join(made.root, ".history", "doc.md");
    await fs.mkdir(revisionDir, { recursive: true });
    await fs.writeFile(
      path.join(revisionDir, "r1.json"),
      JSON.stringify({
        id: "r1",
        path: "doc.md",
        at: 1,
        op: "write",
        bytes: MEMORY_STORAGE_LIMITS.revisionBodyBytes + 1,
        source: { kind: "tool", tool: "test" },
        batch_id: "batch-1",
      }),
    );
    const body = path.join(revisionDir, "r1.md");
    await fs.writeFile(body, "x");
    await fs.truncate(body, MEMORY_STORAGE_LIMITS.revisionBodyBytes + 1);

    await fs.writeFile(path.join(revisionDir, "oversized.json"), "x");
    await fs.truncate(
      path.join(revisionDir, "oversized.json"),
      MEMORY_STORAGE_LIMITS.metadataBytes + 1,
    );
    expect((await revisions.list("doc.md")).map((revision) => revision.id)).toEqual(["r1"]);

    await expect(revisions.read("doc.md", "r1")).rejects.toMatchObject({
      code: "memory_storage_limit",
      kind: "revision body",
    });
    await expect(
      revisions.put(
        {
          id: "r2",
          path: "other.md",
          at: 2,
          op: "write",
          bytes: MEMORY_STORAGE_LIMITS.revisionBodyBytes + 1,
          source: { kind: "tool", tool: "test" },
          batch_id: "batch-2",
        },
        "x".repeat(MEMORY_STORAGE_LIMITS.revisionBodyBytes + 1),
      ),
    ).rejects.toBeInstanceOf(MemoryStorageLimitError);
    expect(await exists(path.join(made.root, ".history", "other.md"))).toBe(false);

    const jobs = createJobRepository({ machineryRoot: made.root, init: made.init });
    const jobsDir = path.join(made.root, ".state", "jobs");
    await fs.mkdir(jobsDir, { recursive: true });
    const job = path.join(jobsDir, `${encodeRunId("run-1")}.json`);
    await fs.writeFile(job, "{");
    await fs.truncate(job, MEMORY_STORAGE_LIMITS.metadataBytes + 1);
    await expect(jobs.reader.get("run-1")).rejects.toMatchObject({
      code: "memory_storage_limit",
      kind: "metadata",
    });
    await expect(jobs.reader.list()).resolves.toEqual([]);
  });

  test("oversized journal input is refused before persistence", async () => {
    const made = await root();
    const journal = createJournalRepository({ machineryRoot: made.root, init: made.init });
    const record = journalRecord();
    record.ops.push({
      op: "write",
      path: "doc.md",
      expected_digest: null,
      next_digest: null,
      revision_id: null,
      previous_body: "x".repeat(MEMORY_STORAGE_LIMITS.metadataBytes),
    });

    await expect(journal.write(record)).rejects.toBeInstanceOf(MemoryStorageLimitError);
    expect(await exists(path.join(made.root, ".journal", record.batch_id))).toBe(false);
  });

  test("an oversized crash journal freezes recovery and is retained as evidence", async () => {
    const made = await root();
    const prepare = path.join(made.root, ".journal", "crashed", "prepare.json");
    await fs.mkdir(path.dirname(prepare), { recursive: true });
    await fs.writeFile(prepare, "{");
    await fs.truncate(prepare, MEMORY_STORAGE_LIMITS.metadataBytes + 1);

    const report = await createFileMemoryStore({ root: made.root }).recover();

    expect(report.required).toBe(true);
    expect(report.entries).toEqual([
      expect.objectContaining({ batch_id: "crashed", outcome: "required" }),
    ]);
    expect(await exists(prepare)).toBe(true);
  });

  test("a journal above the operation cap is retained instead of mistaken for corrupt JSON", async () => {
    const made = await root();
    const record = journalRecord("too-many-ops");
    record.ops = Array.from({ length: MEMORY_STORAGE_LIMITS.batchOperations + 1 }, (_, index) => ({
      op: "delete" as const,
      path: `${String(index)}.md`,
      expected_digest: null,
      next_digest: null,
      revision_id: null,
    }));
    const prepare = path.join(made.root, ".journal", record.batch_id, "prepare.json");
    await fs.mkdir(path.dirname(prepare), { recursive: true });
    await fs.writeFile(prepare, JSON.stringify(record));

    const report = await createFileMemoryStore({ root: made.root }).recover();

    expect(report.required).toBe(true);
    expect(report.entries[0]).toMatchObject({
      batch_id: record.batch_id,
      outcome: "required",
    });
    expect(await exists(prepare)).toBe(true);
  });

  test("batch cardinality fails while all writes are still staged", async () => {
    const store = createInMemoryMemoryStore();

    await expect(
      store.exclusive((tx) =>
        tx.batch({ source: { kind: "tool", tool: "test" } }, async (batch) => {
          for (let index = 0; index <= MEMORY_STORAGE_LIMITS.batchOperations; index += 1) {
            await batch.write(`${String(index)}.md`, "small");
          }
        }),
      ),
    ).rejects.toMatchObject({
      code: "memory_storage_limit",
      kind: "batch operations",
      maximum: MEMORY_STORAGE_LIMITS.batchOperations,
    });
    await expect(store.list()).resolves.toEqual([]);
  });

  test("a batch has one aggregate budget across all staged document bodies", async () => {
    const store = createInMemoryMemoryStore();
    const maximumBody = "x".repeat(MEMORY_STORAGE_LIMITS.documentBytes);
    const admitted = Math.floor(
      MEMORY_STORAGE_LIMITS.corpusBytes / MEMORY_STORAGE_LIMITS.documentBytes,
    );

    await expect(
      store.exclusive((tx) =>
        tx.batch({ source: { kind: "tool", tool: "test" } }, async (batch) => {
          for (let index = 0; index <= admitted; index += 1) {
            await batch.write(`${String(index)}.md`, maximumBody);
          }
        }),
      ),
    ).rejects.toMatchObject({
      code: "memory_storage_limit",
      kind: "corpus",
      maximum: MEMORY_STORAGE_LIMITS.corpusBytes,
    });
    await expect(store.list()).resolves.toEqual([]);
  });

  test("health reports a sparse oversized document without reading its body", async () => {
    const made = await root();
    const file = path.join(made.root, "PROFILE.md");
    await fs.writeFile(file, "---\ndescription: root\n---\n# Profile\n");
    await fs.truncate(file, MEMORY_STORAGE_LIMITS.documentBytes + 1);
    const store = createFileMemoryStore({ root: made.root });

    const report = await health({ tx: store, now: 1 });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "document_too_large", path: "PROFILE.md" }),
    );
    expect(report.truncated).toBe(true);
    expect(report.skipped_codes).toContain("stale_navigation");
  });

  test("recording policy reads only its bounded prefix from a sparse file", async () => {
    const made = await root();
    const policy = path.join(made.root, "policy.md");
    await fs.writeFile(policy, "Keep exact commands.\n");
    await fs.truncate(policy, 64 * 1024 * 1024);

    const composed = loadMemoryPolicy({
      global: policy,
      workspace: path.join(made.root, "missing.md"),
    });

    expect(composed).toContain("Keep exact commands.");
    expect(composed!.length).toBeLessThan(5_000);
  });
});
