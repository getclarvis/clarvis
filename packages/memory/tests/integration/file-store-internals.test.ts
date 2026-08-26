import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { createDocumentRepository } from "../../src/file-store/documents.ts";
import { createJobRepository, encodeRunId } from "../../src/file-store/jobs.ts";
import { createJournalRepository } from "../../src/file-store/journal.ts";
import { createFileStoreLayout } from "../../src/file-store/layout.ts";
import { createTreeLock } from "../../src/file-store/lock.ts";
import { createRecoveryCoordinator } from "../../src/file-store/recovery.ts";
import { createRevisionRepository } from "../../src/file-store/revisions.ts";
import { run } from "../helpers/fixtures.ts";
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("file-store internal repositories", () => {
  test("documents remain sorted and hide machinery", async () => {
    const made = await root();
    const docs = createDocumentRepository({ root: made.root, init: made.init, clock: () => 1 });
    await docs.write("z/MEMORY.md", "---\ndescription: z\n---\n");
    await docs.write("a/MEMORY.md", "---\ndescription: a\n---\n");
    await fs.mkdir(path.join(made.root, ".hidden"));
    await fs.writeFile(path.join(made.root, ".hidden", "MEMORY.md"), "hidden");
    expect((await docs.list()).map((doc) => doc.path)).toEqual(["a/MEMORY.md", "z/MEMORY.md"]);
  });

  test("jobs use safe distinct names and tolerate corrupt JSON", async () => {
    const made = await root();
    const jobs = createJobRepository({ machineryRoot: made.root, init: made.init });
    expect(encodeRunId("a/b")).not.toBe(encodeRunId("a\\b"));
    expect(await jobs.reader.list()).toEqual([]);
    await jobs.tx.enqueue({ run_id: "a/b", snapshot: run({ run_id: "a/b" }), at: 1 });
    await fs.writeFile(
      path.join(made.root, ".state", "jobs", `${encodeRunId("corrupt")}.json`),
      "{",
    );
    expect(await jobs.reader.get("corrupt")).toBeNull();
    expect((await jobs.reader.list()).map((job) => job.run_id)).toEqual(["a/b"]);
  });

  test("a missing jobs directory is an empty queue for every scan", async () => {
    const made = await root();
    const jobs = createJobRepository({ machineryRoot: made.root, init: made.init });

    expect(await jobs.reader.list()).toEqual([]);
    expect(await jobs.reader.counts()).toEqual({
      pending: 0,
      running: 0,
      retry_wait: 0,
      completed: 0,
      failed: 0,
    });
    expect(await jobs.reader.nextDueAt()).toBeUndefined();
    expect(await jobs.tx.claim(1, { ms: 1000, owner: "worker" })).toBeNull();
  });

  test("job pruning removes completed records from the durable queue", async () => {
    const made = await root();
    const jobs = createJobRepository({ machineryRoot: made.root, init: made.init });
    await jobs.tx.enqueue({ run_id: "done", snapshot: run({ run_id: "done" }), at: 1 });
    await jobs.tx.complete("done", 2);
    for (const [runId, at] of [
      ["failed-old", 3],
      ["failed-new", 4],
    ] as const) {
      await jobs.tx.enqueue({ run_id: runId, snapshot: run({ run_id: runId }), at });
      await jobs.tx.fail(runId, at, { phase: "generate", error: "failed" }, { state: "failed" });
    }

    expect(await jobs.tx.prune({ terminalBefore: 10, keepFailed: 1 })).toBe(2);
    expect(await jobs.reader.get("done")).toBeNull();
    expect((await jobs.reader.list({ state: "failed" })).map((job) => job.run_id)).toEqual([
      "failed-new",
    ]);
  });

  test("revision metadata is the commit point", async () => {
    const made = await root();
    const revisions = createRevisionRepository({ machineryRoot: made.root, init: made.init });
    const dir = path.join(made.root, ".history", "PROFILE.md");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "orphan.md"), "body");
    await fs.writeFile(path.join(dir, "broken.json"), "{");
    await fs.writeFile(
      path.join(dir, "missing-body.json"),
      JSON.stringify({
        id: "missing-body",
        path: "PROFILE.md",
        at: 1,
        op: "write",
        bytes: 1,
        source: { kind: "tool", tool: "write_memory" },
        batch_id: "b1",
      }),
    );
    expect((await revisions.list("PROFILE.md")).map((revision) => revision.id)).toEqual([
      "missing-body",
    ]);
    expect(await revisions.read("PROFILE.md", "orphan")).toBeNull();
    expect(await revisions.read("PROFILE.md", "missing-body")).toBeNull();
  });

  test("revision pruning keeps the configured absolute floor and removes both artifacts", async () => {
    const made = await root();
    const revisions = createRevisionRepository({ machineryRoot: made.root, init: made.init });
    for (let index = 0; index < 22; index += 1) {
      const id = `rev-${String(index).padStart(2, "0")}`;
      await revisions.put(
        {
          id,
          path: "PROFILE.md",
          at: 0,
          op: "write",
          bytes: 4,
          source: { kind: "tool", tool: "write_memory" },
          batch_id: "batch",
        },
        "body",
      );
    }

    await revisions.prune(["PROFILE.md"], 100 * 86_400_000);

    const kept = await revisions.list("PROFILE.md");
    expect(kept).toHaveLength(3);
    expect(await revisions.lastInstalledDigest("PROFILE.md")).toBeUndefined();
    const historyDir = path.join(made.root, ".history", "PROFILE.md");
    expect((await fs.readdir(historyDir)).sort()).toHaveLength(6);
  });

  test("journal round-trips records and markers before sweeping", async () => {
    const made = await root();
    const journal = createJournalRepository({ machineryRoot: made.root, init: made.init });
    const record = {
      version: 1,
      batch_id: "b1",
      at: 1,
      source: { kind: "tool", tool: "test" } as const,
      ops: [],
      commit: {},
    };
    await journal.write(record);
    await journal.markApplied("b1");
    expect(await journal.read("b1")).toEqual(record);
    expect(await journal.markerExists("b1", "applied")).toBe(true);
    await journal.sweep("b1");
    expect(await journal.listBatchIds()).toEqual([]);
  });

  test("journal reads reject malformed operation records", async () => {
    const made = await root();
    const journal = createJournalRepository({ machineryRoot: made.root, init: made.init });
    const batchDir = path.join(made.root, ".journal", "bad-op");
    await fs.mkdir(batchDir, { recursive: true });
    await fs.writeFile(
      path.join(batchDir, "prepare.json"),
      JSON.stringify({
        version: 1,
        batch_id: "bad-op",
        at: 1,
        source: { kind: "tool", tool: "test" },
        ops: [null],
        commit: {},
      }),
    );

    expect(await journal.read("bad-op")).toBeNull();
  });

  test("tree lock serializes concurrent holders and supports nesting detection", async () => {
    const made = await root();
    const lock = createTreeLock({
      lockDir: path.join(made.root, ".lock"),
      staleMs: 60_000,
      heartbeatMs: 10,
      timeoutMs: 1_000,
      init: made.init,
    });
    const order: string[] = [];
    let release!: () => void;
    const first = lock.run(async () => {
      expect(lock.nested()).toBe(true);
      order.push("first");
      await new Promise<void>((resolve) => (release = resolve));
    });
    await Bun.sleep(10);
    const second = lock.run(async () => void order.push("second"));
    await Bun.sleep(20);
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("layout initializes once and discards only orphaned transactional bookkeeping", async () => {
    const made = await root();
    const wiki = path.join(made.root, "wiki");
    const machinery = path.join(made.root, "machinery");
    await fs.mkdir(path.join(machinery, ".state", "indexed"), { recursive: true });
    await fs.mkdir(path.join(machinery, ".journal", "batch"), { recursive: true });
    await fs.mkdir(path.join(machinery, ".history"), { recursive: true });
    const layout = createFileStoreLayout({ root: wiki, machineryRoot: machinery });
    await Promise.all([layout.init(), layout.init(), layout.init()]);
    expect((await fs.stat(wiki)).isDirectory()).toBe(true);
    expect(await exists(path.join(machinery, ".state", "indexed"))).toBe(false);
    expect(await exists(path.join(machinery, ".journal"))).toBe(false);
    expect((await fs.stat(path.join(machinery, ".history"))).isDirectory()).toBe(true);
  });

  test("recovery rolls an applied batch forward once and blocks newer journal versions", async () => {
    const record = {
      version: 1,
      batch_id: "applied",
      at: 1,
      source: { kind: "tool", tool: "test" } as const,
      ops: [],
      commit: { mark_indexed: "run-1" },
    };
    let commits = 0;
    let sweeps = 0;
    const coordinator = createRecoveryCoordinator({
      init: () => Promise.resolve(),
      journal: {
        listBatchIds: () => Promise.resolve(["applied"]),
        read: () => Promise.resolve(record),
        markerExists: (_id, marker) => Promise.resolve(marker === "applied"),
        sweep: () => {
          sweeps++;
          return Promise.resolve();
        },
      },
      tree: { read: () => Promise.resolve(null) } as never,
      revisions: { read: () => Promise.resolve(null) } as never,
      runCommit: () => {
        commits++;
        return Promise.resolve();
      },
    });
    await Promise.all([coordinator.recoverOnce(), coordinator.recoverOnce()]);
    expect({ commits, sweeps }).toEqual({ commits: 1, sweeps: 1 });

    const blocked = createRecoveryCoordinator({
      init: () => Promise.resolve(),
      journal: {
        listBatchIds: () => Promise.resolve(["newer"]),
        read: () => Promise.resolve({ ...record, version: 2, batch_id: "newer" }),
        markerExists: () => Promise.resolve(false),
        sweep: () => Promise.resolve(),
      },
      tree: { read: () => Promise.resolve(null) } as never,
      revisions: { read: () => Promise.resolve(null) } as never,
      runCommit: () => Promise.resolve(),
    });
    expect((await blocked.recover()).required).toBe(true);
    expect(() => blocked.assertWritable()).toThrow(/recovery required/);
  });
});
