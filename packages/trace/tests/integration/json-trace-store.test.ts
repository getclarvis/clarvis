import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJsonTraceStore,
  MAX_TRACE_LIST_LIMIT,
  MAX_TRACE_LIST_OFFSET,
  type TraceStore,
} from "@clarvis/trace";
import { ownerSegment as safeSegment, TMP_PREFIX } from "@clarvis/paths";
import { ConflictError, PersistenceError } from "@clarvis/capability";
import { makeExecutionRecord } from "../helpers/execution-record.ts";

const DELETE_INSERT_WORKER = fileURLToPath(
  new URL("../helpers/owner-delete-insert-worker.ts", import.meta.url),
);

function waitForFile(path: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

let dir: string;
let store: TraceStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarvis-json-"));
  store = createJsonTraceStore({ dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("json-trace-store — orphaned temp files", () => {
  it("cleanup reclaims stale tmp orphans (crash between write and rename) but keeps fresh ones", async () => {
    await store.insert(
      makeExecutionRecord({ id: "keep", owner_key_name: "alice", started_at: Date.now() - 60_000 }),
    );
    const ownerDir = join(dir, safeSegment("alice"));
    const staleTmp = join(ownerDir, `${TMP_PREFIX}stale-${"a".repeat(8)}`);
    const freshTmp = join(ownerDir, `${TMP_PREFIX}fresh-${"b".repeat(8)}`);
    const unrelated = join(ownerDir, "notes.txt");
    writeFileSync(staleTmp, "{}");
    writeFileSync(freshTmp, "{}");
    writeFileSync(unrelated, "x");
    const twoHoursAgoSec = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(staleTmp, twoHoursAgoSec, twoHoursAgoSec);

    const removed = store.cleanup(Date.now() - 86_400_000, 1000);

    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(store.getById("alice", "keep")).not.toBeNull();
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

describe("json-trace-store — persisted continuation payload", () => {
  it("atomically replaces final_context and charges compaction usage", async () => {
    await store.insert(
      makeExecutionRecord({
        id: "exec_rewrite",
        owner_key_name: "alice",
        final_context: [
          {
            message: { role: "user", content: "old" },
            evictable: true,
            summary: false,
            canonical: false,
          },
        ],
      }),
    );
    const replaced = await store.replaceFinalContext(
      "alice",
      "exec_rewrite",
      [
        {
          message: { role: "assistant", content: "[summary] smaller" },
          evictable: false,
          summary: true,
          canonical: false,
        },
      ],
      { input: 11, output: 3, cached: 2, cache_write: 1 },
    );
    expect(replaced).toBe(true);
    const stored = store.getById("alice", "exec_rewrite")!;
    expect(stored.final_context?.[0]?.message.content).toBe("[summary] smaller");
    expect(stored.total_input_tokens).toBe(11);
    expect(stored.total_output_tokens).toBe(3);
    expect(stored.total_cached_tokens).toBe(2);
    expect(stored.total_cache_write_tokens).toBe(1);
  });

  it("round-trips final_context/capability_state verbatim — continuation state is never redacted", async () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const finalContext = [
      {
        message: { role: "user" as const, content: "the task" },
        evictable: false,
        summary: false,
        canonical: false,
      },
      {
        message: {
          role: "tool" as const,
          tool_call_id: "c1",
          content: `integrity sha256-${sha} header Bearer abc.def-token`,
        },
        evictable: true,
        summary: false,
        canonical: false,
        task_id: "t1",
      },
    ];
    const planRef = {
      id: "11111111-2222-3333-4444-555555555555",
      path: ".clarvis/plans/p.md",
      final_revision: 2,
      final_spec_revision: 1,
      status: "completed" as const,
      retention: "keep" as const,
    };
    await store.insert(
      makeExecutionRecord({
        id: "exec_ctx",
        owner_key_name: "alice",
        final_context: structuredClone(finalContext),
        capability_state: { plans: structuredClone(planRef) },
      }),
    );
    const got = store.getById("alice", "exec_ctx")!;
    expect(got.final_context).toEqual(finalContext);
    expect(got.capability_state).toEqual({ plans: planRef });
    expect(JSON.stringify(got.final_context)).not.toContain("[redacted]");
    expect(JSON.stringify(got.capability_state)).not.toContain("[redacted]");
  });

  it("still redacts request/response at rest while final_context stays verbatim", async () => {
    const secret = "sk-proj-ABCDEFGH12345678";
    await store.insert(
      makeExecutionRecord({
        id: "exec_mixed",
        owner_key_name: "alice",
        request: {
          messages: [{ role: "user", content: `use ${secret}` }],
          servers: [],
          entry: "solo",
          profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
          providers: [{ name: "anthropic", kind: "anthropic" }],
          budget: { on_exceed: "stop", total_token_limit: 1 },
        },
        response: {
          status: "completed",
          result: `echoed ${secret}`,
          usage: { iterations_used: 1, elapsed_ms: 500, by_agent: [] },
        },
        final_context: [
          {
            message: { role: "tool", tool_call_id: "c1", content: `echoed ${secret}` },
            evictable: true,
            summary: false,
            canonical: false,
          },
        ],
      }),
    );
    const got = store.getById("alice", "exec_mixed")!;
    expect(JSON.stringify(got.request)).not.toContain(secret);
    expect(JSON.stringify(got.response)).not.toContain(secret);
    expect(JSON.stringify(got.final_context)).toContain(secret);
  });

  it("round-trips sanitized host metadata with the execution snapshot", async () => {
    const extensionProfile = {
      id: "global:research",
      fingerprint: `sha256:${"a".repeat(64)}`,
    };
    await store.insert(
      makeExecutionRecord({
        id: "exec_host_metadata",
        owner_key_name: "alice",
        host_metadata: {
          extension_profile: extensionProfile,
          api_token: "sk-proj-ABCDEFGH12345678",
        },
      }),
    );

    const got = store.getById("alice", "exec_host_metadata")!;
    expect(got.host_metadata?.extension_profile).toEqual(extensionProfile);
    expect(JSON.stringify(got.host_metadata)).not.toContain("sk-proj-ABCDEFGH12345678");
  });

  it("omits final_context/capability_state/host_metadata when the record has none", async () => {
    await store.insert(makeExecutionRecord({ id: "exec_plain", owner_key_name: "alice" }));
    const got = store.getById("alice", "exec_plain")!;
    expect(got).not.toHaveProperty("final_context");
    expect(got).not.toHaveProperty("capability_state");
    expect(got).not.toHaveProperty("host_metadata");
  });
});

describe("json-trace-store — per-owner uniqueness", () => {
  const lockFile = (owner: string, id: string): string =>
    join(dir, ".locks", `${safeSegment(owner)}.${safeSegment(id)}.lock`);
  const seedLock = (owner: string, id: string): string => {
    mkdirSync(join(dir, ".locks"), { recursive: true });
    const p = lockFile(owner, id);
    writeFileSync(p, "");
    return p;
  };

  it("rejects an insert when a concurrent inserter holds the id lock (cross-process race)", async () => {
    seedLock("alice", "race");
    await expect(
      store.insert(makeExecutionRecord({ id: "race", owner_key_name: "alice" })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(store.getById("alice", "race")).toBeNull();
  });

  it("removes the id lock after an insert and keeps the id re-insertable after a delete", async () => {
    await store.insert(makeExecutionRecord({ id: "relock", owner_key_name: "alice" }));
    expect(readdirSync(join(dir, ".locks"))).toHaveLength(0);
    expect(store.deleteById("alice", "relock")).toBe(true);
    await store.insert(makeExecutionRecord({ id: "relock", owner_key_name: "alice" }));
    expect(store.getById("alice", "relock")).not.toBeNull();
  });

  it("insert reclaims a stale orphaned id lock inline (no data file) instead of a false conflict", async () => {
    const lockPath = seedLock("alice", "stale");
    const twoHoursAgoSec = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(lockPath, twoHoursAgoSec, twoHoursAgoSec);

    await store.insert(makeExecutionRecord({ id: "stale", owner_key_name: "alice" }));
    expect(store.getById("alice", "stale")).not.toBeNull();
  });

  it("cleanup reclaims a stale orphaned id lock, unblocking the id again", async () => {
    const lockPath = seedLock("alice", "orphan");
    const twoHoursAgoSec = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(lockPath, twoHoursAgoSec, twoHoursAgoSec);

    expect(store.cleanup(0, 1000)).toBeGreaterThanOrEqual(1);
    expect(existsSync(lockPath)).toBe(false);
    await store.insert(makeExecutionRecord({ id: "orphan", owner_key_name: "alice" }));
  });

  it("cleanup never reclaims a stale-looking lock whose owner process is live", () => {
    const lockPath = lockFile("alice", "live-owner");
    mkdirSync(join(dir, ".locks"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "live-owner",
        acquiredAt: Date.now() - 2 * 3_600_000,
      }),
    );
    const twoHoursAgoSec = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(lockPath, twoHoursAgoSec, twoHoursAgoSec);

    expect(store.cleanup(0, 1000)).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("json-trace-store — delete", () => {
  it("deleteOwner erases one owner's rows and locks and leaves every other owner intact", async () => {
    await store.insert(makeExecutionRecord({ id: "a1", owner_key_name: "alice" }));
    await store.insert(makeExecutionRecord({ id: "a2", owner_key_name: "alice" }));
    await store.insert(makeExecutionRecord({ id: "b1", owner_key_name: "bob" }));
    mkdirSync(join(dir, ".locks"), { recursive: true });
    const aliceLock = join(dir, ".locks", `${safeSegment("alice")}.${safeSegment("a1")}.lock`);
    const bobLock = join(dir, ".locks", `${safeSegment("bob")}.${safeSegment("b1")}.lock`);
    const aliceGeneration = join(
      dir,
      ".locks",
      `${safeSegment("alice")}.${safeSegment("orphan")}.insert-generation`,
    );
    writeFileSync(aliceLock, "1");
    writeFileSync(bobLock, "1");
    writeFileSync(aliceGeneration, "obsolete-generation");
    const old = (Date.now() - 1_000) / 1000;
    utimesSync(aliceLock, old, old);

    expect(store.deleteOwner("alice")).toBe(2);

    expect(store.getById("alice", "a1")).toBeNull();
    expect(store.list("alice", 10, 0)).toEqual({ items: [], total: 0 });
    expect(existsSync(join(dir, safeSegment("alice")))).toBe(false);
    expect(existsSync(aliceLock)).toBe(false);
    expect(existsSync(aliceGeneration)).toBe(false);
    expect(store.getById("bob", "b1")).not.toBeNull();
    expect(existsSync(bobLock)).toBe(true);
  });

  it("accepts a legacy raw generation marker and tags the next insert with it", async () => {
    const owner = "legacy-generation";
    const ownerSeg = safeSegment(owner);
    const locksDir = join(dir, ".locks");
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, `${ownerSeg}.delete-generation`), "raw-generation-token");

    await store.insert(makeExecutionRecord({ id: "legacy-record", owner_key_name: owner }));

    expect(store.getById(owner, "legacy-record")?.id).toBe("legacy-record");
    expect(store.list(owner, 10, 0).total).toBe(1);
  });

  it("deleteOwner does not touch a lock whose owner segment merely shares a prefix", async () => {
    await store.insert(makeExecutionRecord({ id: "a1", owner_key_name: "a" }));
    mkdirSync(join(dir, ".locks"), { recursive: true });
    const neighbour = join(dir, ".locks", `${safeSegment("ab")}.${safeSegment("x")}.lock`);
    writeFileSync(neighbour, "1");

    expect(store.deleteOwner("a")).toBe(1);
    expect(existsSync(neighbour)).toBe(true);
  });

  it("deleteOwner prevents an already-locked insert from recreating the deleted owner", async () => {
    let deletedDuringInsert = false;
    const inserting = createJsonTraceStore({
      dir,
      afterInsertWrite(record) {
        if (record.id !== "in-flight") return;
        const lock = join(dir, ".locks", `${safeSegment("alice")}.${safeSegment(record.id)}.lock`);
        expect(existsSync(lock)).toBe(true);
        store.deleteOwner("alice");
        deletedDuringInsert = true;
      },
    });

    const outcome = await inserting
      .insert(makeExecutionRecord({ id: "in-flight", owner_key_name: "alice" }))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(deletedDuringInsert).toBe(true);
    expect(outcome).toBeInstanceOf(PersistenceError);
    expect(inserting.getById("alice", "in-flight")).toBeNull();
    expect(inserting.list("alice", 10, 0)).toEqual({ items: [], total: 0 });

    await inserting.insert(makeExecutionRecord({ id: "after-delete", owner_key_name: "alice" }));
    expect(inserting.getById("alice", "after-delete")?.id).toBe("after-delete");
  });

  it("rejects a cross-process insert while the new generation is still being deleted", async () => {
    await store.insert(
      makeExecutionRecord({ id: "before-delete", owner_key_name: "alice", started_at: 1 }),
    );
    const readyPath = join(dir, "worker.ready");
    const startPath = join(dir, "worker.start");
    const resultPath = join(dir, "worker.result");
    const worker = Bun.spawn(
      [process.execPath, DELETE_INSERT_WORKER, dir, readyPath, startPath, resultPath],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      waitForFile(readyPath);
      const deletingStore = createJsonTraceStore({
        dir,
        beforeOwnerRemove(owner) {
          expect(owner).toBe("alice");
          const state = JSON.parse(
            readFileSync(join(dir, ".locks", `${safeSegment(owner)}.delete-generation`), "utf8"),
          ) as { state: string };
          expect(state.state).toBe("deleting");
          writeFileSync(startPath, "start");
          waitForFile(resultPath);
        },
      });

      expect(deletingStore.deleteOwner("alice")).toBe(1);
      const [exitCode, stderr] = await Promise.all([
        worker.exited,
        new Response(worker.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
        ok: false,
        code: "persistence_failure",
      });
      expect(store.getById("alice", "during-delete")).toBeNull();

      await store.insert(
        makeExecutionRecord({ id: "after-delete", owner_key_name: "alice", started_at: 3 }),
      );
      expect(store.getById("alice", "after-delete")?.id).toBe("after-delete");
    } finally {
      if (worker.exitCode === null) worker.kill();
      await worker.exited;
    }
  });

  it("finishes a crashed deleting generation before accepting the next insert", async () => {
    await store.insert(
      makeExecutionRecord({ id: "before-crash", owner_key_name: "alice", started_at: 1 }),
    );
    const ownerSeg = safeSegment("alice");
    const locksDir = join(dir, ".locks");
    const generationPath = join(locksDir, `${ownerSeg}.delete-generation`);
    const leasePath = join(locksDir, `${ownerSeg}.delete-lease`);
    writeFileSync(
      generationPath,
      JSON.stringify({ version: 1, state: "deleting", generation: "recovered-generation" }),
    );
    writeFileSync(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "dead-deleter",
        acquiredAt: Date.now() - 10_000,
      }),
    );
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(leasePath, old, old);

    const reopened = createJsonTraceStore({ dir });
    await reopened.insert(
      makeExecutionRecord({ id: "after-recovery", owner_key_name: "alice", started_at: 2 }),
    );

    expect(reopened.getById("alice", "before-crash")).toBeNull();
    expect(reopened.getById("alice", "after-recovery")?.id).toBe("after-recovery");
    expect(reopened.list("alice", 10, 0).total).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
    expect(JSON.parse(readFileSync(generationPath, "utf8"))).toEqual({
      version: 1,
      state: "active",
      generation: "recovered-generation",
    });
  });

  it("keeps a pre-delete record invisible if its writer dies before rolling it back", async () => {
    expect(store.deleteOwner("alice")).toBe(0);
    const ownerSeg = safeSegment("alice");
    const record = makeExecutionRecord({
      id: "crashed-insert",
      owner_key_name: "alice",
      started_at: 1,
    });
    const recordName = `1.${safeSegment(record.id)}.json`;
    const ownerDir = join(dir, ownerSeg);
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(join(ownerDir, recordName), JSON.stringify(record));
    writeFileSync(
      join(dir, ".locks", `${ownerSeg}.${safeSegment(recordName)}.insert-generation`),
      "generation-before-delete",
    );

    const reopened = createJsonTraceStore({ dir });
    expect(reopened.getById("alice", record.id)).toBeNull();
    expect(reopened.list("alice", 10, 0)).toEqual({ items: [], total: 0 });
    expect(reopened.listAcrossOwners!(10, 0)).toEqual({ items: [], total: 0 });

    await reopened.insert(
      makeExecutionRecord({ id: record.id, owner_key_name: "alice", started_at: 2 }),
    );
    expect(reopened.getById("alice", record.id)?.started_at).toBe(2);
  });
});

describe("json-trace-store — cleanup cutoff", () => {
  it("cleanup on an empty root returns 0", () => {
    expect(store.cleanup(Date.now(), 100)).toBe(0);
  });
});

describe("json-trace-store — on-disk layout & permissions", () => {
  it("writes <started_at>.<idSegment>.json under <dir>/<owner>/ with strict modes", async () => {
    await store.insert(
      makeExecutionRecord({ id: "exec_layout", owner_key_name: "alice", started_at: 42 }),
    );
    const ownerDir = join(dir, "alice");
    const record = `42.${safeSegment("exec_layout")}.json`;
    const names = readdirSync(ownerDir).filter((n) => n !== ".seq");
    expect(names.sort()).toEqual([record, `42.${safeSegment("exec_layout")}.summary`].sort());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(ownerDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(ownerDir, record)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind after an insert", async () => {
    await store.insert(makeExecutionRecord({ id: "exec_tmp", owner_key_name: "alice" }));
    const names = readdirSync(join(dir, "alice"));
    expect(names.some((n) => n.startsWith(TMP_PREFIX))).toBe(false);
  });

  it("a fresh store instance re-reads records written by a previous one", async () => {
    await store.insert(makeExecutionRecord({ id: "persisted", owner_key_name: "alice" }));
    const reopened = createJsonTraceStore({ dir });
    expect(reopened.getById("alice", "persisted")?.id).toBe("persisted");
    expect(reopened.list("alice", 10, 0).total).toBe(1);
  });
});

describe("json-trace-store — filesystem-safe segments", () => {
  it("stores and round-trips a dangerous id ('..') without escaping the dir", async () => {
    await store.insert(makeExecutionRecord({ id: "..", owner_key_name: "alice", started_at: 7 }));
    expect(store.getById("alice", "..")?.id).toBe("..");
    expect(existsSync(join(dir, "alice", "..", "7...json"))).toBe(false);
    const names = readdirSync(join(dir, "alice")).filter((n) => n !== ".seq");
    expect(names.sort()).toEqual(
      [`7.${safeSegment("..")}.json`, `7.${safeSegment("..")}.summary`].sort(),
    );
  });

  it("stores and round-trips an owner containing a path separator", async () => {
    await store.insert(makeExecutionRecord({ id: "x", owner_key_name: "a/b" }));
    expect(store.getById("a/b", "x")?.id).toBe("x");
    expect(readdirSync(dir)).toContain(safeSegment("a/b"));
  });

  it("falls back to a bounded hash for ids that would exceed the filename limit", async () => {
    const longId = ":".repeat(128);
    const seg = safeSegment(longId);
    expect(seg.startsWith("h_")).toBe(true);
    expect(seg.length).toBeLessThan(80);
    await store.insert(makeExecutionRecord({ id: longId, owner_key_name: "alice", started_at: 3 }));
    expect(store.getById("alice", longId)?.id).toBe(longId);
  });
});

describe("json-trace-store — ordering & cleanup edge cases", () => {
  it("breaks started_at ties deterministically (by id, descending)", async () => {
    for (const id of ["m", "z", "a"]) {
      await store.insert(makeExecutionRecord({ id, owner_key_name: "alice", started_at: 500 }));
    }
    expect(store.list("alice", 20, 0).items.map((i) => i.id)).toEqual(["z", "m", "a"]);
  });

  it("keeps lookup and listing correct when an owner outgrows its cached id index", async () => {
    const bounded = createJsonTraceStore({ dir, maxOwnerIndexEntries: 1 });
    for (const [id, startedAt] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const) {
      await bounded.insert(
        makeExecutionRecord({ id, owner_key_name: "bounded-owner", started_at: startedAt }),
      );
    }

    const reopened = createJsonTraceStore({ dir, maxOwnerIndexEntries: 1 });
    expect(reopened.getById("bounded-owner", "c")?.id).toBe("c");
    expect(reopened.getById("bounded-owner", "a")?.id).toBe("a");
    expect(reopened.list("bounded-owner", 10, 0).items.map((item) => item.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(reopened.deleteById("bounded-owner", "c")).toBe(true);
    expect(reopened.existsForOwner("bounded-owner", "c")).toBe(false);
  });

  it("bounds list windows before allocating and keeps offset ordering stable", async () => {
    for (let startedAt = 1; startedAt <= 24; startedAt += 1) {
      await store.insert(
        makeExecutionRecord({
          id: `run-${String(startedAt).padStart(2, "0")}`,
          owner_key_name: "alice",
          started_at: startedAt,
        }),
      );
    }

    expect(store.list("alice", 5, 7).items.map((item) => item.started_at)).toEqual([
      17, 16, 15, 14, 13,
    ]);
    expect(() => store.list("alice", MAX_TRACE_LIST_LIMIT + 1, 0)).toThrow(PersistenceError);
    expect(() => store.list("alice", 1, MAX_TRACE_LIST_OFFSET + 1)).toThrow(PersistenceError);
    expect(() => store.list("alice", Number.POSITIVE_INFINITY, 0)).toThrow(PersistenceError);
  });

  it("maintains a bounded newest-first heap for adversarial directory ordering", async () => {
    const order = [17, 91, 4, 63, 28, 100, 2, 77, 39, 88, 11, 95, 6, 54, 31, 82, 23, 99, 1, 70];
    for (const startedAt of order) {
      await store.insert(
        makeExecutionRecord({
          id: `heap-${String(startedAt).padStart(3, "0")}`,
          owner_key_name: "heap-owner",
          started_at: startedAt,
        }),
      );
    }

    expect(store.list("heap-owner", 3, 0).items.map((item) => item.started_at)).toEqual([
      100, 99, 95,
    ]);
    expect(store.listAcrossOwners!(3, 0).items.map((item) => item.started_at)).toEqual([
      100, 99, 95,
    ]);
  });

  it("cleanup on a not-yet-created traces directory returns 0", () => {
    const missing = createJsonTraceStore({ dir: join(dir, "never-created") });
    expect(missing.cleanup(Date.now(), 100)).toBe(0);
  });

  it("cleanup ignores stray non-directory entries at the root", async () => {
    await store.insert(makeExecutionRecord({ id: "old", owner_key_name: "alice", started_at: 1 }));
    writeFileSync(join(dir, "stray-file"), "not a dir");
    expect(store.cleanup(10_000, 100)).toBe(1);
    expect(store.getById("alice", "old")).toBeNull();
    expect(existsSync(join(dir, "stray-file"))).toBe(true);
  });

  it("cleanup protects raw execution ids whose filenames require owner encoding", async () => {
    await store.insert(
      makeExecutionRecord({ id: "exec.with/slash", owner_key_name: "alice", started_at: 1 }),
    );

    expect(store.cleanup(10_000, 100, undefined, new Set(["exec.with/slash"]))).toBe(0);
    expect(store.getById("alice", "exec.with/slash")).not.toBeNull();
  });

  it("cleanup retains only the oldest bounded batch even with hostile programmatic input", async () => {
    for (const startedAt of [5, 1, 4, 2, 3]) {
      await store.insert(
        makeExecutionRecord({
          id: `old-${startedAt}`,
          owner_key_name: "alice",
          started_at: startedAt,
        }),
      );
    }

    expect(store.cleanup(10, 2)).toBe(2);
    expect(store.getById("alice", "old-1")).toBeNull();
    expect(store.getById("alice", "old-2")).toBeNull();
    expect(store.list("alice", 10, 0).items.map((item) => item.id)).toEqual([
      "old-5",
      "old-4",
      "old-3",
    ]);
    expect(store.cleanup(10, Number.POSITIVE_INFINITY)).toBe(3);
  });

  it("bounds scan work per cleanup call and resumes from the prior directory cursor", async () => {
    const bounded = createJsonTraceStore({ dir, maxCleanupScanEntries: 1 });
    await bounded.insert(
      makeExecutionRecord({ id: "old-cursor", owner_key_name: "alice", started_at: 1 }),
    );

    // The first unit of work is a root directory entry, not an unbounded sweep
    // through that entry's contents.
    expect(bounded.cleanup(10, 100)).toBe(0);
    let removed = 0;
    for (let pass = 0; pass < 20 && removed === 0; pass += 1) {
      removed += bounded.cleanup(10, 100);
    }
    expect(removed).toBe(1);
    expect(bounded.getById("alice", "old-cursor")).toBeNull();
  });
});

describe("json-trace-store — seq-guarded index sees external writes", () => {
  it("a long-lived store finds records another instance wrote after its index was built", async () => {
    const a = createJsonTraceStore({ dir });
    const b = createJsonTraceStore({ dir });
    await a.insert(makeExecutionRecord({ id: "x", owner_key_name: "alice" }));
    expect(b.getById("alice", "x")?.id).toBe("x");
    await a.insert(makeExecutionRecord({ id: "y", owner_key_name: "alice" }));
    expect(b.getById("alice", "y")?.id).toBe("y");
    expect(b.existsForOwner("alice", "y")).toBe(true);
    expect(b.list("alice", 10, 0).total).toBe(2);
  });

  it("a long-lived store stops finding a record another instance deleted", async () => {
    const a = createJsonTraceStore({ dir });
    const b = createJsonTraceStore({ dir });
    await a.insert(makeExecutionRecord({ id: "gone", owner_key_name: "alice" }));
    expect(b.getById("alice", "gone")?.id).toBe("gone");
    a.deleteById("alice", "gone");
    expect(b.getById("alice", "gone")).toBeNull();
    expect(b.existsForOwner("alice", "gone")).toBe(false);
  });
});

describe("json-trace-store — list resilience", () => {
  it("skips a corrupt file instead of aborting the whole listing", async () => {
    await store.insert(
      makeExecutionRecord({ id: "good", owner_key_name: "alice", started_at: 2_000 }),
    );
    const ownerSeg = readdirSync(dir).find((n) => n !== ".locks");
    writeFileSync(join(dir, ownerSeg!, "1000.corrupt.json"), "{ not valid json");
    const res = store.list("alice", 10, 0);
    expect(res.items.map((i) => i.id)).toEqual(["good"]);
  });
});

describe("json-trace-store — listAcrossOwners", () => {
  it("skips a corrupt file for one owner instead of aborting the whole cross-owner page", async () => {
    await store.insert(
      makeExecutionRecord({ id: "good", owner_key_name: "alice", started_at: 2_000 }),
    );
    await store.insert(makeExecutionRecord({ id: "b1", owner_key_name: "bob", started_at: 3_000 }));
    const aliceSeg = readdirSync(dir).find((n) => n !== ".locks" && n !== safeSegment("bob"));
    writeFileSync(join(dir, aliceSeg!, "1000.corrupt.json"), "{ not valid json");

    const page = store.listAcrossOwners!(10, 0);

    expect(page.items.map((i) => i.id).sort()).toEqual(["b1", "good"]);
  });

  it("skips a corrupt file when narrowed to that owner too", async () => {
    await store.insert(
      makeExecutionRecord({ id: "good", owner_key_name: "alice", started_at: 2_000 }),
    );
    const ownerSeg = readdirSync(dir).find((n) => n !== ".locks");
    writeFileSync(join(dir, ownerSeg!, "1000.corrupt.json"), "{ not valid json");

    const page = store.listAcrossOwners!(10, 0, { owner: "alice" });

    expect(page.items.map((i) => i.id)).toEqual(["good"]);
  });

  it("still works when detached from the store object (does not rely on `this`)", async () => {
    await store.insert(makeExecutionRecord({ id: "a1", owner_key_name: "alice" }));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point of this test is that detaching is safe
    const { listAcrossOwners } = store;
    expect(listAcrossOwners!(10, 0, { owner: "alice" }).items.map((i) => i.id)).toEqual(["a1"]);
    expect(listAcrossOwners!(10, 0).total).toBe(1);
  });
});

describe("json-trace-store — bounded record bodies", () => {
  const recordOf = (owner: string, id: string, startedAt: number): string =>
    join(dir, safeSegment(owner), `${startedAt}.${safeSegment(id)}.json`);
  const sidecarOf = (owner: string, id: string, startedAt: number): string =>
    join(dir, safeSegment(owner), `${startedAt}.${safeSegment(id)}.summary`);

  it("rejects an oversized serialized insert before publishing its record", async () => {
    const bounded = createJsonTraceStore({ dir, maxRecordBytes: 1_024 });
    const base = makeExecutionRecord({
      id: "too-large-to-write",
      owner_key_name: "alice",
      started_at: 7_000,
    });

    await expect(
      bounded.insert({
        ...base,
        response: {
          status: "completed",
          result: "x".repeat(4_096),
          usage: base.response.usage,
        },
      }),
    ).rejects.toMatchObject({
      code: "persistence_failure",
      details: { kind: "record", max_bytes: 1_024 },
    });
    expect(existsSync(recordOf("alice", "too-large-to-write", 7_000))).toBe(false);
  });

  it("stats a sparse oversized record before get or legacy listing fallback reads it", async () => {
    await store.insert(
      makeExecutionRecord({ id: "sparse-record", owner_key_name: "alice", started_at: 8_000 }),
    );
    const record = recordOf("alice", "sparse-record", 8_000);
    rmSync(sidecarOf("alice", "sparse-record", 8_000));
    truncateSync(record, 1024 * 1024);
    chmodSync(record, 0o000);
    const bounded = createJsonTraceStore({ dir, maxRecordBytes: 1_024 });

    try {
      bounded.getById("alice", "sparse-record");
      expect.unreachable("getById should reject the oversized sparse body");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect(error).toMatchObject({
        details: {
          kind: "record",
          actual_bytes: 1024 * 1024,
          max_bytes: 1_024,
        },
      });
    }

    expect(bounded.list("alice", 10, 0)).toEqual({ items: [], total: 1 });
    expect(bounded.listAcrossOwners!(10, 0)).toEqual({ items: [], total: 1 });
  });
});

describe("json-trace-store — summary sidecar", () => {
  const ownerDirOf = (owner: string): string => join(dir, safeSegment(owner));
  const sidecarOf = (owner: string, id: string, startedAt: number): string =>
    join(ownerDirOf(owner), `${startedAt}.${safeSegment(id)}.summary`);

  it("writes a sidecar beside the record and serves list from it", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s1", owner_key_name: "alice", started_at: 1_000 }),
    );
    const path = sidecarOf("alice", "s1", 1_000);
    expect(existsSync(path)).toBe(true);
    expect(store.list("alice", 10, 0).items[0]).toEqual(
      JSON.parse(readFileSync(path, "utf8")) as unknown as never,
    );
  });

  it("returns the identical summary whether it came from the sidecar or the fallback", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s2", owner_key_name: "alice", started_at: 1_000 }),
    );
    const fromSidecar = store.list("alice", 10, 0).items[0]!;

    rmSync(sidecarOf("alice", "s2", 1_000));
    const fromRecord = createJsonTraceStore({ dir }).list("alice", 10, 0).items[0]!;

    expect(fromRecord).toEqual(fromSidecar);
  });

  it("still lists correctly with the sidecar removed, and does not recreate it", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s3", owner_key_name: "alice", started_at: 1_000 }),
    );
    const path = sidecarOf("alice", "s3", 1_000);
    rmSync(path);

    expect(store.list("alice", 10, 0).items.map((i) => i.id)).toEqual(["s3"]);
    expect(existsSync(path)).toBe(false);
  });

  it("is not counted as an execution by list, the index, or deleteOwner", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s4", owner_key_name: "alice", started_at: 1_000 }),
    );

    const page = store.list("alice", 10, 0);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(store.listAcrossOwners!(10, 0).total).toBe(1);
    expect(createJsonTraceStore({ dir }).list("alice", 10, 0).total).toBe(1);
    expect(store.deleteOwner("alice")).toBe(1);
  });

  it("is removed with the record by deleteById", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s5", owner_key_name: "alice", started_at: 1_000 }),
    );
    expect(store.deleteById("alice", "s5")).toBe(true);
    expect(existsSync(sidecarOf("alice", "s5", 1_000))).toBe(false);
    expect(readdirSync(ownerDirOf("alice")).filter((n) => n !== ".seq")).toEqual([]);
  });

  it("is removed with the record by cleanup, without counting against the batch", async () => {
    await store.insert(
      makeExecutionRecord({ id: "old", owner_key_name: "alice", started_at: 1_000 }),
    );
    await store.insert(
      makeExecutionRecord({ id: "new", owner_key_name: "alice", started_at: 9_000 }),
    );

    expect(store.cleanup(5_000, 10)).toBe(1);
    expect(existsSync(sidecarOf("alice", "old", 1_000))).toBe(false);
    expect(existsSync(sidecarOf("alice", "new", 9_000))).toBe(true);
    expect(store.list("alice", 10, 0).items.map((i) => i.id)).toEqual(["new"]);
  });

  it("falls back to the record when the sidecar is corrupt", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s6", owner_key_name: "alice", started_at: 1_000 }),
    );
    writeFileSync(sidecarOf("alice", "s6", 1_000), "{ not valid json");

    expect(store.list("alice", 10, 0).items.map((i) => i.id)).toEqual(["s6"]);
  });

  it("stats an oversized sidecar and falls back without parsing its poisoned body", async () => {
    await store.insert(
      makeExecutionRecord({ id: "s7", owner_key_name: "alice", started_at: 1_000 }),
    );
    const path = sidecarOf("alice", "s7", 1_000);
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...valid, id: "poisoned-sidecar", padding: "x".repeat(2_048) }),
    );
    expect(statSync(path).size).toBeGreaterThan(512);
    const bounded = createJsonTraceStore({ dir, maxSummaryBytes: 512 });

    expect(bounded.list("alice", 10, 0).items.map((item) => item.id)).toEqual(["s7"]);
    expect(bounded.listAcrossOwners!(10, 0).items.map((item) => item.id)).toEqual(["s7"]);
  });
});

describe("json-trace-store getById — corrupt file", () => {
  it("throws a typed PersistenceError naming the id", async () => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-corrupt-"));
    const store = createJsonTraceStore({ dir });
    await store.insert(makeExecutionRecord({ id: "exec_corrupt", owner_key_name: "o" }));

    const ownerDir = join(dir, "o");
    const file = readdirSync(ownerDir).find((n) => n.endsWith(".json"))!;
    writeFileSync(join(ownerDir, file), "{ not valid json");

    expect(() => store.getById("o", "exec_corrupt")).toThrowError(PersistenceError);
    try {
      store.getById("o", "exec_corrupt");
      expect.unreachable("getById should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      expect((err as Error).message).toContain("exec_corrupt");
    }
  });

  it("a valid file still rehydrates normally", async () => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-corrupt-ok-"));
    const store = createJsonTraceStore({ dir });
    await store.insert(makeExecutionRecord({ id: "exec_ok", owner_key_name: "o" }));
    expect(store.getById("o", "exec_ok")?.id).toBe("exec_ok");
  });
});
