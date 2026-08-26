import { describe, expect, test } from "bun:test";

import { DEFAULT_BUDGETS } from "../../src/config.ts";
import type { MemoryClock } from "../../src/clock.ts";
import { drainIndexJobs } from "../../src/drain.ts";
import { createInMemoryMemoryStore, createTestClock } from "../../src/testing.ts";
import type { IndexerRuntime, MemoryStore } from "../../src/types.ts";
import { doc, run } from "../helpers/fixtures.ts";
import { fakeIndexerRuntime, writeStep } from "../helpers/indexer-runtime.ts";

/** A process-local store with one queued job. */
async function storeWithJob(runId: string): Promise<MemoryStore> {
  const store = createInMemoryMemoryStore();
  await store.exclusive((tx) =>
    tx.jobs.enqueue({
      run_id: runId,
      snapshot: run({ run_id: runId }),
      at: 1,
      provider_key: "wiki:local",
    }),
  );
  return store;
}

/** An indexer whose every model call throws, standing in for a transport fault.
 *
 * @remarks A fresh runtime per pass, because the resolver is called per pass and
 * a shared `MockLLM` would carry its cursor across them — the second pass would
 * then fail on an exhausted script rather than on what the test is about. */
function throwingIndexer(message: string): () => IndexerRuntime {
  return () => fakeIndexerRuntime([{ throw: new Error(message) }]).runtime;
}

/**
 * An indexer that touches a leaf and then tries to stop, leaving the pyramid
 * open. The finalize gate sends it back each time until the run's iterations run
 * out — the modern spelling of "the model could not produce a usable set".
 */
function openPyramidIndexer(): () => IndexerRuntime {
  return () =>
    fakeIndexerRuntime([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
      ...Array.from({ length: 30 }, () => ({ text: "done" })),
    ]).runtime;
}

describe("drainIndexJobs failure classification", () => {
  test("renews a live lease with the current clock while a model call is in flight", async () => {
    const store = await storeWithJob("renewed");
    const clock = createTestClock(100);
    const runtime = fakeIndexerRuntime([{ text: "nothing to record" }]);
    const inner = runtime.runtime.deps.llm;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.runtime.deps = {
      ...runtime.runtime.deps,
      llm: {
        async call(params) {
          markStarted();
          await held;
          return inner.call(params);
        },
      },
    };

    const draining = drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      clock,
      leaseMs: 100,
      owner: "worker",
    });
    await started;
    expect((await store.jobs.get("renewed"))?.lease_until).toBe(200);
    await clock.advance(50);
    expect((await store.jobs.get("renewed"))?.lease_until).toBe(250);
    release();

    const report = await draining;
    expect(report.completed).toBe(1);
    expect((await store.jobs.get("renewed"))?.state).toBe("completed");
    expect(clock.pending()).toBe(0);
  });

  test("a reclaimed stale worker cannot mutate the wiki or mark its run indexed", async () => {
    const store = await storeWithJob("reclaimed");
    let current = 100;
    const stalledClock: MemoryClock = {
      now: () => current,
      // Simulate an event-loop stall: wall time advances, but the old worker's
      // renewal callback never gets a turn before another process reclaims.
      after: () => () => undefined,
    };
    const runtime = fakeIndexerRuntime([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun\nUse bun test.")),
      { text: "done" },
    ]);
    const inner = runtime.runtime.deps.llm;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.runtime.deps = {
      ...runtime.runtime.deps,
      llm: {
        async call(params) {
          markStarted();
          await held;
          return inner.call(params);
        },
      },
    };

    const staleDrain = drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      clock: stalledClock,
      leaseMs: 100,
      owner: "worker-a",
    });
    await started;
    current = 201;
    const reclaimed = await store.exclusive((tx) =>
      tx.jobs.claim(current, {
        ms: 100,
        owner: "worker-b",
        token: "worker-b-claim",
      }),
    );
    expect(reclaimed?.lease_owner).toBe("worker-b");
    release();

    const report = await staleDrain;
    expect(report).toMatchObject({ completed: 0, blocked: 1 });
    expect(await store.read("infra/bun/MEMORY.md")).toBeNull();
    expect(await store.wasIndexed("reclaimed")).toBe(false);
    expect(await store.jobs.get("reclaimed")).toMatchObject({
      state: "running",
      lease_owner: "worker-b",
      lease_token: "worker-b-claim",
    });
  });

  test("a reclaimed no-op worker is fenced before markIndexed", async () => {
    const store = await storeWithJob("reclaimed-noop");
    let current = 100;
    const stalledClock: MemoryClock = {
      now: () => current,
      after: () => () => undefined,
    };
    const runtime = fakeIndexerRuntime([{ text: "nothing to record" }]);
    const inner = runtime.runtime.deps.llm;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.runtime.deps = {
      ...runtime.runtime.deps,
      llm: {
        async call(params) {
          markStarted();
          await held;
          return inner.call(params);
        },
      },
    };

    const staleDrain = drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      clock: stalledClock,
      leaseMs: 100,
      owner: "worker-a",
    });
    await started;
    current = 201;
    await store.exclusive((tx) =>
      tx.jobs.claim(current, {
        ms: 100,
        owner: "worker-b",
        token: "worker-b-noop",
      }),
    );
    release();

    const report = await staleDrain;
    expect(report).toMatchObject({ completed: 0, blocked: 1 });
    expect(await store.wasIndexed("reclaimed-noop")).toBe(false);
    expect(await store.jobs.get("reclaimed-noop")).toMatchObject({
      state: "running",
      lease_owner: "worker-b",
      lease_token: "worker-b-noop",
    });
  });

  test("a provider failure is charged to `generate`, not `validate`", async () => {
    const store = await storeWithJob("r1");
    const indexer = throwingIndexer("connection reset by peer");

    for (let pass = 1; pass <= 3; pass++) {
      await drainIndexJobs({
        store,
        indexer,
        budgets: DEFAULT_BUDGETS,
        now: pass * 10_000_000,
        owner: "o",
      });
    }

    const job = await store.jobs.get("r1");
    expect(job).not.toBeNull();
    expect(job?.history.map((a) => a.phase)).toEqual(["generate", "generate", "generate"]);
    expect(job?.attempts).toBe(3);
    expect(job?.state).toBe("retry_wait");
  });

  test("the full retry budget is spent before a transport failure gives up", async () => {
    const store = await storeWithJob("r2");
    const indexer = throwingIndexer("socket hang up");

    for (let pass = 1; pass <= 6; pass++) {
      await drainIndexJobs({
        store,
        indexer,
        budgets: DEFAULT_BUDGETS,
        now: pass * 10_000_000,
        owner: "o",
      });
    }

    const job = await store.jobs.get("r2");
    expect(job?.state).toBe("failed");
    expect(job?.attempts).toBe(5);
  });

  /**
   * A run that ends without the finalize gate ever passing is the modern
   * `validate` failure: the model was asked what was wrong and still could not
   * close the pyramid across a whole run of tool calls, so two attempts is the
   * right budget — the same judgement the old "bad JSON twice" rule encoded.
   */
  test("a run that never closes the pyramid is a validate failure, capped at 2", async () => {
    const store = await storeWithJob("r3");
    const indexer = openPyramidIndexer();

    for (let pass = 1; pass <= 4; pass++) {
      await drainIndexJobs({
        store,
        indexer,
        budgets: DEFAULT_BUDGETS,
        now: pass * 10_000_000,
        owner: "o",
      });
    }

    const job = await store.jobs.get("r3");
    expect(job?.history.map((a) => a.phase)).toEqual(["validate", "validate"]);
    expect(job?.state).toBe("failed");
  });

  test("a pass sweeps records past their retention bound", async () => {
    const store = await storeWithJob("old-pending");
    // No indexer, so the job is reported blocked and stays pending — the exact
    // record that used to accumulate forever once a model-less workspace began
    // enqueueing anyway.
    const blocked = await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 1_000,
      owner: "o",
      retention: { terminalMs: 10, pendingMs: 10_000_000, keepFailed: 5 },
    });
    expect(blocked.blocked).toBe(1);
    expect((await store.jobs.get("old-pending"))?.state).toBe("pending");

    await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 2_000,
      owner: "o",
      retention: { terminalMs: 10, pendingMs: 100, keepFailed: 5 },
    });
    expect(await store.jobs.get("old-pending")).toBeNull();
  });

  test("an idle pass sweeps nothing, so a quiet workspace never takes the lock for it", async () => {
    const store = await storeWithJob("old");
    await store.exclusive(async (tx) => {
      const claimed = await tx.jobs.claim(1, { ms: 1000, owner: "o" });
      await tx.jobs.complete("old", 1, undefined, {
        owner: "o",
        token: claimed?.lease_token ?? "missing-claim-token",
      });
    });

    const quiet = (): IndexerRuntime => fakeIndexerRuntime([{ text: "nothing" }]).runtime;

    // Nothing is due, so the pass claims nothing and settles nothing — the
    // prunable record survives because the sweep is skipped, not because it
    // was spared.
    const idle = await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 500_000,
      owner: "o",
      indexer: quiet,
      retention: { terminalMs: 10, pendingMs: 10, keepFailed: 0 },
    });
    expect(idle.claimed).toBe(0);
    expect(idle.jobs).toEqual([]);
    expect(await store.jobs.get("old")).not.toBeNull();

    // A pass with real work pays for the sweep, and it takes the old record.
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "fresh",
        snapshot: run({ run_id: "fresh" }),
        at: 500_001,
        provider_key: "wiki:local",
      }),
    );
    await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 500_002,
      owner: "o",
      indexer: quiet,
      retention: { terminalMs: 400_000, pendingMs: 400_000, keepFailed: 0 },
    });
    expect(await store.jobs.get("old")).toBeNull();
  });

  test("a shutdown mid-pass releases the claim instead of failing the job", async () => {
    const store = await storeWithJob("r4");
    // The pass must still be ITERATING when the controller aborts — a run whose
    // single call is already in flight finishes normally, because the signal is
    // observed between iterations, not inside a provider call. A string of
    // navigation calls keeps it going long enough for the abort to land.
    const aborting = (controller: AbortController): IndexerRuntime => {
      const { runtime } = fakeIndexerRuntime(
        Array.from({ length: 10 }, () => ({
          toolCalls: [{ name: "query_memories", arguments: { query: "x" } }],
        })),
      );
      const llm = runtime.deps.llm;
      runtime.deps = {
        ...runtime.deps,
        llm: {
          async call(params) {
            const result = await llm.call(params);
            controller.abort();
            return result;
          },
        },
      };
      return runtime;
    };

    for (let pass = 1; pass <= 3; pass++) {
      const controller = new AbortController();
      const report = drainIndexJobs({
        store,
        indexer: () => aborting(controller),
        budgets: DEFAULT_BUDGETS,
        now: pass * 10_000_000,
        owner: "o",
        signal: controller.signal,
      });
      const settled = await report;
      expect(settled.blocked).toBe(1);
      expect(settled.failed).toBe(0);
    }

    const job = await store.jobs.get("r4");
    expect(job?.state).toBe("pending");
    expect(job?.attempts).toBe(0);
    expect(job?.history).toEqual([]);
  });

  test("legacy jobs with no provider identity complete without inference", async () => {
    const store = createInMemoryMemoryStore();
    await store.exclusive((tx) =>
      tx.jobs.enqueue({ run_id: "legacy", snapshot: run({ run_id: "legacy" }), at: 1 }),
    );
    const runtime = fakeIndexerRuntime([{ throw: new Error("must not run") }]);
    const report = await drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      now: 2,
      owner: "o",
    });
    expect(report.jobs).toEqual([
      {
        run_id: "legacy",
        outcome: "completed",
        note: "provider-selection-unknown",
      },
    ]);
    expect(runtime.llm.calls).toHaveLength(0);
  });

  test("a convergence shortcut reports a lost lease when its strict settlement expires", async () => {
    const store = createInMemoryMemoryStore();
    await store.exclusive((tx) =>
      tx.jobs.enqueue({
        run_id: "legacy-expired",
        snapshot: run({ run_id: "legacy-expired" }),
        at: 1,
      }),
    );
    let reads = 0;
    const expiringClock: MemoryClock = {
      now: () => (reads++ === 0 ? 100 : 201),
      after: () => () => undefined,
    };
    const runtime = fakeIndexerRuntime([{ throw: new Error("must not run") }]);

    const report = await drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      clock: expiringClock,
      leaseMs: 100,
      limit: 1,
      owner: "late-worker",
    });

    expect(report).toMatchObject({ claimed: 1, completed: 0, blocked: 1 });
    expect(report.jobs).toEqual([
      {
        run_id: "legacy-expired",
        outcome: "blocked",
        note: "the index claim was lost before settlement",
      },
    ]);
    expect(await store.jobs.get("legacy-expired")).toMatchObject({
      state: "running",
      lease_owner: "late-worker",
      lease_until: 200,
    });
    expect(runtime.llm.calls).toHaveLength(0);
  });

  test("a provider selection change completes the old job without inference", async () => {
    const store = await storeWithJob("changed");
    const runtime = fakeIndexerRuntime([{ throw: new Error("must not run") }]);
    runtime.runtime.memoryProviderKey = "plugin:new";
    const report = await drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      now: 2,
      owner: "o",
    });
    expect(report.jobs[0]).toMatchObject({
      outcome: "completed",
      note: "provider-selection-changed",
    });
    expect(runtime.llm.calls).toHaveLength(0);
  });

  test("no_progress is terminal and is never replayed", async () => {
    const store = await storeWithJob("stuck");
    const runtime = fakeIndexerRuntime(
      Array.from({ length: 8 }, () => ({
        toolCalls: [{ name: "read_memory", arguments: { path: "missing/MEMORY.md" } }],
      })),
    );
    const first = await drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      now: 2,
      owner: "o",
    });
    expect(first.failed).toBe(1);
    expect((await store.jobs.get("stuck"))?.state).toBe("failed");
    const callCount = runtime.llm.calls.length;
    const second = await drainIndexJobs({
      store,
      indexer: () => runtime.runtime,
      budgets: DEFAULT_BUDGETS,
      now: 10_000_000,
      owner: "o",
    });
    expect(second.claimed).toBe(0);
    expect(runtime.llm.calls).toHaveLength(callCount);
  });
});
