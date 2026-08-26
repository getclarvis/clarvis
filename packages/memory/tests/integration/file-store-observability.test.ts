/**
 * What the file-backed store reports about work no return value carries: a
 * tree lock held across an inference, an interrupted batch recovered on open,
 * and a queued job record that can no longer be read back.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createFileMemoryStore } from "../../src/file-store.ts";
import { createTreeLock, DEFAULT_LOCK_WARN_MS } from "../../src/file-store/lock.ts";
import { encodeRunId } from "../../src/file-store/jobs.ts";
import type { MemoryJournalRecord } from "../../src/journal.ts";
import { digestBody } from "../../src/revisions.ts";
import { run } from "../helpers/fixtures.ts";
import { makeRoot } from "../helpers/fs.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";

const doc = (body: string): string => `---\ndescription: bun facts\n---\n${body}\n`;

describe("memory.lock.held_long", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
  });
  afterEach(() => cleanup());

  test("reports a hold that outlasted a batch of writes, and the threshold it passed", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger, lock: { warnMs: 0 } });

    await store.exclusive(async (tx) => {
      await tx.write("PROFILE.md", doc("profile"));
      await new Promise((resolve) => setTimeout(resolve, 2));
    });

    const held = log.one("memory.lock.held_long");
    expect(held.level).toBe("warn");
    expect(held.fields.threshold_ms).toBe(0);
    expect(held.fields.nested).toBe(false);
    expect(held.fields.held_ms as number).toBeGreaterThanOrEqual(0);
    expect(held.fields.lock_dir as string).toContain(root);
  });

  test("says nothing for an ordinary hold, and defaults its threshold to five seconds", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });

    await store.exclusive((tx) => tx.write("PROFILE.md", doc("profile")));

    expect(log.of("memory.lock.held_long")).toHaveLength(0);
    expect(DEFAULT_LOCK_WARN_MS).toBe(5_000);
  });

  test("names a nested hold as nested, so a re-entrant caller is not read as a slow one", async () => {
    const log = recordingLogger();
    const lock = createTreeLock({
      lockDir: path.join(root, ".lock-nested"),
      staleMs: 60_000,
      heartbeatMs: 15_000,
      timeoutMs: 5_000,
      init: () => Promise.resolve(),
      warnMs: 0,
      logger: log.logger,
    });

    await lock.run(async () => {
      await lock.run(async () => {
        expect(lock.nested()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    });

    const nested = log.of("memory.lock.held_long").map((r) => r.fields.nested);
    expect(nested).toEqual([true, false]);
  });
});

describe("memory.lock.wait", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
  });
  afterEach(() => cleanup());

  const lockOptions = (log: ReturnType<typeof recordingLogger>) => ({
    lockDir: path.join(root, ".lock-contended"),
    staleMs: 5,
    heartbeatMs: 15_000,
    timeoutMs: 5_000,
    init: () => Promise.resolve(),
    logger: log.logger,
  });

  test("reports the queue and whether a dead holder's lock was stolen", async () => {
    const log = recordingLogger("debug");
    const lock = createTreeLock(lockOptions(log));
    await fs.mkdir(path.join(root, ".lock-contended"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, ".lock-contended", "holder"), "999999999.dead");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await lock.run(() => Promise.resolve());

    const wait = log.one("memory.lock.wait");
    expect(wait.level).toBe("debug");
    expect(wait.fields.stolen).toBe(true);
    expect(wait.fields.waited_ms as number).toBeGreaterThanOrEqual(0);
  });

  test("builds no record at all when the logger discards debug", async () => {
    const log = recordingLogger("info");
    const lock = createTreeLock(lockOptions(log));
    await fs.mkdir(path.join(root, ".lock-contended"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, ".lock-contended", "holder"), "999999999.dead");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await lock.run(() => Promise.resolve());

    expect(log.of("memory.lock.wait")).toHaveLength(0);
  });

  test("an uncontended acquisition says nothing", async () => {
    const log = recordingLogger("debug");
    const lock = createTreeLock(lockOptions(log));
    await lock.run(() => Promise.resolve());
    expect(log.of("memory.lock.wait")).toHaveLength(0);
  });
});

describe("memory.recovery.applied", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
  });
  afterEach(() => cleanup());

  async function plant(rec: MemoryJournalRecord): Promise<void> {
    const dir = path.join(root, ".journal", rec.batch_id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prepare.json"), JSON.stringify(rec));
  }

  test("counts what an interrupted batch did to the tree on the next open", async () => {
    await plant({
      version: 1,
      batch_id: "b-swept",
      at: 1,
      source: { kind: "indexer", run_id: "run-1" },
      ops: [],
      commit: {},
    });
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });

    await store.exclusive(() => Promise.resolve());

    const applied = log.one("memory.recovery.applied");
    expect(applied.level).toBe("warn");
    expect(applied.fields).toMatchObject({
      batches: 1,
      rolled_forward: 0,
      rolled_back: 1,
      swept: 0,
      required: false,
    });
    expect(applied.fields.blocked_batch_id).toBeUndefined();
  });

  test("names the batch that froze the tree, and says so once", async () => {
    await fs.mkdir(path.join(root, ".journal", "b-empty"), { recursive: true });
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });

    await store.exclusive(() => Promise.resolve());
    await store.exclusive(() => Promise.resolve());

    const applied = log.one("memory.recovery.applied");
    expect(applied.fields).toMatchObject({ batches: 1, swept: 1, required: false });
  });

  test("names the batch that froze the tree against writes", async () => {
    const store = createFileMemoryStore({ root });
    await store.write("infra/bun/MEMORY.md", doc("original"));
    const historyDir = path.join(root, ".history", "infra/bun/MEMORY.md");
    await fs.mkdir(historyDir, { recursive: true });
    await fs.writeFile(path.join(historyDir, "rev-1.md"), doc("original"));
    await fs.writeFile(
      path.join(historyDir, "rev-1.json"),
      JSON.stringify({
        id: "rev-1",
        path: "infra/bun/MEMORY.md",
        at: 1,
        op: "write",
        previous_digest: digestBody(doc("original")),
        bytes: Buffer.byteLength(doc("original")),
        source: { kind: "indexer", run_id: "run-1" },
        batch_id: "b-frozen",
      }),
    );
    await store.write("infra/bun/MEMORY.md", doc("a human wrote this"));
    await plant({
      version: 1,
      batch_id: "b-frozen",
      at: 1,
      source: { kind: "indexer", run_id: "run-1" },
      ops: [
        {
          op: "write",
          path: "infra/bun/MEMORY.md",
          expected_digest: digestBody(doc("original")),
          next_digest: digestBody(doc("the batch wanted this")),
          revision_id: "rev-1",
        },
      ],
      commit: {},
    });

    const log = recordingLogger();
    const reopened = createFileMemoryStore({ root, logger: log.logger });
    await expect(reopened.exclusive(() => Promise.resolve())).resolves.toBeUndefined();

    const applied = log.one("memory.recovery.applied");
    expect(applied.fields).toMatchObject({ required: true, blocked_batch_id: "b-frozen" });
    expect(applied.message).toContain("frozen");
  });

  test("a clean tree reports nothing", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });
    await store.exclusive((tx) => tx.write("PROFILE.md", doc("profile")));
    expect(log.of("memory.recovery.applied")).toHaveLength(0);
  });
});

describe("memory.job.record_corrupt", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
  });
  afterEach(() => cleanup());

  const jobsDir = (): string => path.join(root, ".state", "jobs");

  test("names a record the scan skipped, so a lost run's learning is not silent", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "run-ok",
        snapshot: run({ run_id: "run-ok" }),
        at: 1,
        provider_key: "wiki:local",
      }),
    );
    await fs.writeFile(path.join(jobsDir(), "broken.json"), "{ not json");

    const listed = await store.jobs.list({});

    expect(listed.map((job) => job.run_id)).toEqual(["run-ok"]);
    const corrupt = log.one("memory.job.record_corrupt");
    expect(corrupt.level).toBe("warn");
    expect(corrupt.fields).toMatchObject({ file: "broken.json", reason: "unreadable_record" });
  });

  test("distinguishes a record filed under someone else's run id", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "run-ok",
        snapshot: run({ run_id: "run-ok" }),
        at: 1,
        provider_key: "wiki:local",
      }),
    );
    const good = await fs.readFile(path.join(jobsDir(), `${encodeRunId("run-ok")}.json`), "utf8");
    await fs.writeFile(path.join(jobsDir(), "misfiled.json"), good);

    await store.jobs.list({});

    expect(log.one("memory.job.record_corrupt").fields.reason).toBe("run_id_mismatch");
  });

  test("a direct read of an unreadable record reports it too", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "run-ok",
        snapshot: run({ run_id: "run-ok" }),
        at: 1,
        provider_key: "wiki:local",
      }),
    );
    await fs.writeFile(path.join(jobsDir(), `${encodeRunId("run-ok")}.json`), "{}");

    expect(await store.jobs.get("run-ok")).toBeNull();
    expect(log.one("memory.job.record_corrupt").fields.file).toBe(`${encodeRunId("run-ok")}.json`);
  });

  test("samples a wholly corrupt directory rather than making the report the incident", async () => {
    const log = recordingLogger();
    const store = createFileMemoryStore({ root, logger: log.logger });
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "run-ok",
        snapshot: run({ run_id: "run-ok" }),
        at: 1,
        provider_key: "wiki:local",
      }),
    );
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(jobsDir(), `broken-${String(i)}.json`), "{ not json");
    }

    await store.jobs.list({});

    const reported = log.of("memory.job.record_corrupt").length;
    expect(reported).toBeGreaterThan(0);
    expect(reported).toBeLessThan(20);
  });
});
