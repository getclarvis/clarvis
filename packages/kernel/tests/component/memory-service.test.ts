import { describe, it, expect } from "bun:test";
import type { MemoryFactory } from "@clarvis/memory/capability";
import type {
  Memory,
  ReviewDigest,
  MemoryIndexJob,
  MemoryHealthReport,
  MemoryQueryResult,
} from "@clarvis/memory";
import { createMemoryService } from "../../src/memory/memory-service.ts";

type StoreOver = Partial<Memory["store"]>;

/**
 * `Memory.store.jobs` (the durable-queue store) and `Memory.jobs` (the
 * inspection method) share the property name `jobs` with unrelated shapes, so
 * the top-level method gets its own key here (`jobsFn`) to avoid an
 * unsatisfiable intersection type.
 */
type MemOver = StoreOver &
  Omit<Partial<Memory>, "jobs"> & {
    jobsFn?: Memory["jobs"];
  };

function fakeMemory(over: MemOver = {}): Memory {
  const store: Memory["store"] = {
    list: over.list ?? (async () => []),
    read: over.read ?? (async () => null),
    grep: over.grep ?? (async () => []),
    write: over.write ?? (async () => {}),
    delete: over.delete ?? (async () => false),
    wasIndexed: over.wasIndexed ?? (async () => false),
    markIndexed: over.markIndexed ?? (async () => {}),
    version: over.version ?? (async () => "v"),
    revisions: over.revisions ?? { list: async () => [], read: async () => null },
    jobs: over.jobs ?? {
      get: async () => null,
      list: async () => [],
      counts: async () => ({ pending: 0, running: 0, retry_wait: 0, completed: 0, failed: 0 }),
      nextDueAt: async () => undefined,
    },
    recover: over.recover ?? (async () => ({ entries: [], required: false })),
    // The fake applies a batch immediately rather than staging it: these tests
    // exercise projection and error mapping, not batch semantics, which have
    // their own conformance cases in @clarvis/memory.
    exclusive:
      over.exclusive ??
      ((fn) =>
        fn({
          ...store,
          revisions: { list: async () => [], read: async () => null },
          jobs: {
            ...store.jobs,
            enqueue: async () => {
              throw new Error("not used by these tests");
            },
            claim: async () => null,
            renew: async () => true,
            refreshOwnedAfterFence: async () => true,
            complete: async () => true,
            fail: async () => true,
            release: async () => true,
            retry: async () => null,
            prune: async () => 0,
          },
          batch: (_input, body) =>
            body({
              id: "fake-batch",
              read: (p) => store.read(p),
              list: () => store.list(),
              write: (p, c) => store.write(p, c),
              delete: (p) => store.delete(p),
            }),
        })),
  };
  return {
    review: over.review ?? (async () => ({}) as ReviewDigest),
    reindex: over.reindex ?? (async () => []),
    query:
      over.query ??
      (async () =>
        ({ hits: [], scanned: 0, listed: 0, terms: [], truncated: false }) as MemoryQueryResult),
    health: over.health ?? (async () => ({}) as MemoryHealthReport),
    jobs: over.jobsFn ?? (async () => []),
    retryJob: over.retryJob ?? (async () => null),
    store,
  } as unknown as Memory;
}

function indexJob(over: Partial<MemoryIndexJob> = {}): MemoryIndexJob {
  return {
    run_id: "run-1",
    state: "pending",
    enqueued_at: 100,
    updated_at: 100,
    attempts: 0,
    history: [],
    ...over,
  };
}

function factoryOf(memory: Memory | undefined): MemoryFactory {
  return {
    forOwner: () => memory,
    forOwnerControlPlane: () => memory,
    start: () => {},
    poke: () => {},
    stop: async () => {},
    subscribeToRun: () => () => {},
  };
}
describe("createMemoryService", () => {
  it("rejects every method with capability_disabled when memory is off", async () => {
    const svc = createMemoryService({ factory: factoryOf(undefined), owner: "o" });
    await expect(svc.health()).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(svc.reindex()).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(svc.jobs()).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(svc.retryJob("run-1")).rejects.toMatchObject({ code: "capability_disabled" });
  });

  it("also rejects when no factory was wired at all", async () => {
    const svc = createMemoryService({ factory: undefined, owner: "o" });
    await expect(svc.health()).rejects.toMatchObject({ code: "capability_disabled" });
  });

  it("runs deterministic health diagnostics", async () => {
    const report: MemoryHealthReport = {
      generated_at: 500,
      totals: { documents: 1, topics: 0, memories: 1, pending_jobs: 0, failed_jobs: 0 },
      counts: { info: 0, warning: 0, error: 0 },
      findings: [],
      truncated: false,
      skipped_codes: [],
    };
    const svc = createMemoryService({
      factory: factoryOf(fakeMemory({ health: async () => report })),
      owner: "o",
    });
    expect(await svc.health()).toEqual(report);
  });

  it("reindexes on demand, without a transaction handle so it takes the tree lock", async () => {
    // The remedy health() names for missing_profile / stale_navigation; before
    // this it could only happen as a side effect of a write.
    const handles: unknown[] = [];
    const svc = createMemoryService({
      factory: factoryOf(
        fakeMemory({
          reindex: async (tx) => {
            handles.push(tx);
            return ["PROFILE.md", "infra/TOPIC.md"];
          },
        }),
      ),
      owner: "o",
    });
    expect(await svc.reindex()).toEqual({ reindexed: ["PROFILE.md", "infra/TOPIC.md"] });
    expect(handles).toEqual([undefined]);
  });

  it("lists jobs with state/limit passed through, plus counts, clamping an over-large limit", async () => {
    let seenFilter: unknown;
    const counts = { pending: 1, running: 0, retry_wait: 0, completed: 2, failed: 1 };
    const svc = createMemoryService({
      factory: factoryOf(
        fakeMemory({
          jobsFn: async (filter) => {
            seenFilter = filter;
            return [
              indexJob({
                run_id: "run-1",
                not_before: 900,
                note: "retrying soon",
                history: [{ at: 50, phase: "generate", error: "boom" }],
              }),
              indexJob({ run_id: "run-2" }),
            ];
          },
          jobs: { counts: async () => counts } as unknown as Memory["store"]["jobs"],
        }),
      ),
      owner: "o",
    });
    const res = await svc.jobs({ state: "pending", limit: 10_000 });
    expect(seenFilter).toEqual({ state: "pending", limit: 100 });
    expect(res.counts).toEqual(counts);
    expect(res.jobs).toEqual([
      {
        run_id: "run-1",
        state: "pending",
        attempts: 0,
        enqueued_at: 100,
        updated_at: 100,
        next_attempt_at: 900,
        last_error: { phase: "generate", message: "boom", at: 50 },
        note: "retrying soon",
      },
      {
        run_id: "run-2",
        state: "pending",
        attempts: 0,
        enqueued_at: 100,
        updated_at: 100,
      },
    ]);
  });

  it("lists jobs with no filter, defaulting limit and omitting optional fields", async () => {
    const svc = createMemoryService({
      factory: factoryOf(
        fakeMemory({
          jobsFn: async () => [indexJob()],
        }),
      ),
      owner: "o",
    });
    const res = await svc.jobs();
    expect(res.jobs).toEqual([
      { run_id: "run-1", state: "pending", attempts: 0, enqueued_at: 100, updated_at: 100 },
    ]);
  });

  it("retries a failed job, mapping the revived job or null", async () => {
    const svc = createMemoryService({
      factory: factoryOf(
        fakeMemory({
          retryJob: async (runId) => (runId === "run-1" ? indexJob({ state: "pending" }) : null),
        }),
      ),
      owner: "o",
    });
    expect(await svc.retryJob("run-1")).toEqual({
      run_id: "run-1",
      state: "pending",
      attempts: 0,
      enqueued_at: 100,
      updated_at: 100,
    });
    expect(await svc.retryJob("run-missing")).toBeNull();
  });

  it("maps a package failure thrown mid-operation into a tagged kernel error", async () => {
    const err = Object.assign(new Error("nope"), { code: "memory_recovery_required" });
    const svc = createMemoryService({
      factory: factoryOf(
        fakeMemory({
          health: async () => {
            throw err;
          },
        }),
      ),
      owner: "o",
    });
    await expect(svc.health()).rejects.toMatchObject({
      details: { memory_code: "MEMORY_RECOVERY_REQUIRED" },
    });
  });
});
