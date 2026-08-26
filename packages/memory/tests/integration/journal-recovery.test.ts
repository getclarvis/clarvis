import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createFileMemoryStore } from "../../src/file-store.ts";
import { createMemory } from "../../src/index.ts";
import type { MemoryJournalRecord } from "../../src/journal.ts";
import { digestBody } from "../../src/revisions.ts";
import type { MemoryStore } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";
import { makeRoot } from "../helpers/fs.ts";

const LEAF = "infra/bun/MEMORY.md";
const doc = (body: string): string => `---\ndescription: bun facts\n---\n${body}\n`;

/**
 * Build a journal record by hand, as a crashed process would have left one.
 *
 * A "crash" for the file backend is simply constructing this state on disk and
 * then opening a fresh store over the same root: that exercises the reopen
 * invariant directly, with no fault-injection hook in production code.
 */
function record(partial: Partial<MemoryJournalRecord> = {}): MemoryJournalRecord {
  return {
    version: 1,
    batch_id: "b1",
    at: 1_700_000_000_000,
    source: { kind: "indexer", run_id: "run-1" },
    ops: [],
    commit: {},
    ...partial,
  };
}

describe("file-store recovery", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let store: MemoryStore;
  let memory: Memory;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
    store = createFileMemoryStore({ root });
    memory = createMemory({ store });
  });
  afterEach(() => cleanup());

  const journalDir = (batchId: string): string => path.join(root, ".journal", batchId);

  async function plantJournal(rec: MemoryJournalRecord, markers: string[] = []): Promise<void> {
    await fs.mkdir(journalDir(rec.batch_id), { recursive: true });
    await fs.writeFile(path.join(journalDir(rec.batch_id), "prepare.json"), JSON.stringify(rec));
    for (const marker of markers) {
      await fs.writeFile(path.join(journalDir(rec.batch_id), marker), "");
    }
  }

  /** Reopening the root is what a restarted process does. */
  const reopen = (): MemoryStore => createFileMemoryStore({ root });

  async function seedRevision(relPath: string, body: string, revisionId: string): Promise<void> {
    const dir = path.join(root, ".history", relPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${revisionId}.md`), body);
    await fs.writeFile(
      path.join(dir, `${revisionId}.json`),
      JSON.stringify({
        id: revisionId,
        path: relPath,
        at: 1,
        op: "write",
        previous_digest: digestBody(body),
        bytes: Buffer.byteLength(body),
        source: { kind: "indexer", run_id: "run-1" },
        batch_id: "b1",
      }),
    );
  }

  test("a batch interrupted mid-apply is rolled back to byte-identical content", async () => {
    await store.write(LEAF, doc("original"));
    await store.write("PROFILE.md", doc("profile"));
    const before = await store.version();

    // The batch got as far as writing the leaf but never marked `applied`.
    await seedRevision(LEAF, doc("original"), "rev-1");
    await store.write(LEAF, doc("half applied"));
    await plantJournal(
      record({
        ops: [
          {
            op: "write",
            path: LEAF,
            expected_digest: digestBody(doc("original")),
            next_digest: digestBody(doc("half applied")),
            revision_id: "rev-1",
          },
        ],
      }),
    );

    const report = await reopen().recover();

    expect(report.required).toBe(false);
    expect(report.entries[0]!.outcome).toBe("rolled_back");
    expect(await store.read(LEAF)).toBe(doc("original"));
    expect(await store.version()).toBe(before);
  });

  test("a batch that created a document is rolled back by deleting it", async () => {
    await store.write(LEAF, doc("created but never committed"));
    await plantJournal(
      record({
        ops: [
          {
            op: "write",
            path: LEAF,
            expected_digest: null,
            next_digest: digestBody(doc("created but never committed")),
            revision_id: null,
          },
        ],
      }),
    );

    await reopen().recover();

    expect(await store.read(LEAF)).toBeNull();
  });

  test("a batch past its applied marker replays its declared commit work", async () => {
    await store.write(LEAF, doc("applied"));
    expect(await store.wasIndexed("run-1")).toBe(false);

    await plantJournal(
      record({
        commit: { mark_indexed: "run-1" },
        ops: [
          {
            op: "write",
            path: LEAF,
            expected_digest: null,
            next_digest: digestBody(doc("applied")),
            revision_id: null,
          },
        ],
      }),
      ["applied"],
    );

    const report = await reopen().recover();

    expect(report.entries[0]!.outcome).toBe("rolled_forward");
    expect(await store.wasIndexed("run-1")).toBe(true);
    expect(await store.read(LEAF)).toBe(doc("applied"));
  });

  test("a fully committed batch is only swept", async () => {
    await store.write(LEAF, doc("done"));
    await plantJournal(record({ ops: [] }), ["applied", "commit"]);

    const report = await reopen().recover();

    expect(report.entries[0]!.outcome).toBe("swept");
    expect(await store.read(LEAF)).toBe(doc("done"));
  });

  test("recovery is idempotent across repeated opens", async () => {
    await store.write(LEAF, doc("done"));
    await plantJournal(record({ ops: [] }), ["applied", "commit"]);

    const first = await reopen().recover();
    const second = await reopen().recover();

    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(0);
    expect(await store.read(LEAF)).toBe(doc("done"));
  });

  test("a journal that never landed leaves nothing to undo", async () => {
    await store.write(LEAF, doc("untouched"));
    await fs.mkdir(journalDir("b-empty"), { recursive: true });

    const report = await reopen().recover();

    expect(report.entries[0]!.outcome).toBe("swept");
    expect(await store.read(LEAF)).toBe(doc("untouched"));
  });

  test("a human edit during an interrupted batch freezes mutation but not reads", async () => {
    await store.write(LEAF, doc("original"));
    await seedRevision(LEAF, doc("original"), "rev-1");
    await store.write(LEAF, doc("a human wrote this"));
    await plantJournal(
      record({
        ops: [
          {
            op: "write",
            path: LEAF,
            expected_digest: digestBody(doc("original")),
            next_digest: digestBody(doc("the batch wanted this")),
            revision_id: "rev-1",
          },
        ],
      }),
    );

    const reopened = createFileMemoryStore({ root });
    const report = await reopened.recover();

    expect(report.required).toBe(true);
    expect(report.entries[0]!.outcome).toBe("required");
    // The human's bytes are never overwritten.
    expect(await reopened.read(LEAF)).toBe(doc("a human wrote this"));
    // Reads keep working so the UI can still explain the situation...
    expect((await reopened.list()).map((d) => d.path)).toContain(LEAF);
    // ...but mutation is refused until an operator resolves it.
    const frozen = createMemory({ store: reopened });
    const res = await frozen.tools
      .find((t) => t.name === "write_memory")!
      .execute({ path: LEAF, content: doc("nope") });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("recovery required");
  });

  test("a half-written revision is invisible, so metadata is the commit point", async () => {
    // Body first, metadata second: a crash between them must not surface a
    // revision whose bytes may be incomplete.
    const dir = path.join(root, ".history", LEAF);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "rev-orphan.md"), doc("torn"));

    expect(await store.revisions.list(LEAF)).toEqual([]);
    expect(await store.revisions.read(LEAF, "rev-orphan")).toBeNull();
  });

  test("operational directories stay invisible to listing, grep and version", async () => {
    await store.write(LEAF, doc("v1"));
    const baseline = await store.version();
    await memory.tools
      .find((t) => t.name === "write_memory")!
      .execute({ path: LEAF, content: doc("v2") });

    // History and journal now exist on disk; neither may look like a document.
    expect(await fs.readdir(path.join(root, ".history"))).not.toHaveLength(0);
    expect((await store.list()).every((d) => !d.path.startsWith("."))).toBe(true);
    expect((await store.grep("bun facts")).every((h) => !h.path.startsWith("."))).toBe(true);
    expect(await store.version()).not.toBe(baseline);
  });
});
