import { beforeEach, describe, expect, test } from "bun:test";

import { createMemory } from "../../src/index.ts";
import { createInMemoryMemoryStore, createTestClock } from "../../src/testing.ts";
import { createIndexWorker } from "../../src/worker.ts";
import type { MemoryStore } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";
import type { MockLLM, MockLLMScriptStep } from "@clarvis/loop/testing";
import { doc, run } from "../helpers/fixtures.ts";
import { fakeIndexerRuntime, writeStep } from "../helpers/indexer-runtime.ts";

/** Let queued macrotasks and promise chains settle without a wall-clock wait. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("memory job orchestration", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createInMemoryMemoryStore();
  });

  /** A {@link Memory} whose indexer runs a real pass over `script`. */
  const memoryWith = (script?: MockLLMScriptStep[]): { memory: Memory; llm?: MockLLM } => {
    if (script === undefined) return { memory: createMemory({ store }) };
    const { runtime, llm } = fakeIndexerRuntime(script);
    return { memory: createMemory({ store, indexer: () => runtime }), llm };
  };

  test("the facade revives a failed job only through retryJob", async () => {
    const { memory } = memoryWith();
    await memory.enqueue(run({ run_id: "r1" }));
    await store.exclusive(async (tx) => {
      const claimed = await tx.jobs.claim(0, { ms: 1, owner: "worker", token: "claim-1" });
      expect(claimed).not.toBeNull();
      await tx.jobs.fail(
        "r1",
        0,
        { phase: "generate", error: "provider down" },
        { state: "failed" },
        { owner: "worker", token: "claim-1" },
      );
    });

    const revived = await memory.retryJob("r1");

    expect(revived).toMatchObject({ state: "pending", attempts: 0 });
    expect(revived?.history[0]?.error).toContain("provider down");
    expect(await memory.retryJob("unknown-run")).toBeNull();
  });

  test("drains a queued run into the wiki and completes the job", async () => {
    const { memory } = memoryWith([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun\nmise pins it")),
      writeStep("infra/TOPIC.md", doc("infra", "# Infra")),
      writeStep("PROFILE.md", doc("p", "# P")),
      { text: "recorded" },
    ]);
    await memory.enqueue(run({ run_id: "r1" }));

    const report = await memory.drain();

    expect(report).toMatchObject({ claimed: 1, completed: 1 });
    expect(await store.read("infra/bun/MEMORY.md")).toContain("mise pins it");
    expect(await store.jobs.get("r1")).toMatchObject({ state: "completed" });
    expect((await store.jobs.get("r1"))?.snapshot).toBeUndefined();
    expect(report.jobs[0]).toMatchObject({ written: 3, deleted: 0 });
    expect(typeof report.jobs[0]?.reindexed).toBe("boolean");
  });

  test("a run already folded in completes without a second model call", async () => {
    const { memory, llm } = memoryWith([{ text: "nothing to record" }]);
    await memory.enqueue(run({ run_id: "r1" }));
    await store.markIndexed("r1");

    const report = await memory.drain();

    expect(report.completed).toBe(1);
    expect(report.jobs[0]?.note).toBe("already-indexed");
    expect(llm!.calls).toHaveLength(0);
    expect(await store.jobs.get("r1")).toMatchObject({ state: "completed" });
    expect(report.jobs[0]?.written).toBeUndefined();
    expect(report.jobs[0]?.deleted).toBeUndefined();
    expect(report.jobs[0]?.reindexed).toBeUndefined();
  });

  test("reschedules a failing pass instead of losing the run", async () => {
    const { memory } = memoryWith([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
      { text: "done" },
      { text: "done" },
      { text: "done" },
      { text: "done" },
    ]);
    await memory.enqueue(run({ run_id: "r1" }));

    const report = await memory.drain();

    expect(report.retried).toBe(1);
    expect(await store.jobs.get("r1")).toMatchObject({
      state: "retry_wait",
      snapshot: expect.any(Object),
    });
    expect((await store.jobs.get("r1"))?.not_before).toBeGreaterThan(Date.now());
    expect(await store.wasIndexed("r1")).toBe(false);
  });

  test("a workspace with no model blocks without consuming an attempt", async () => {
    const { memory } = memoryWith();
    await memory.enqueue(run({ run_id: "r1" }));

    const report = await memory.drain();

    expect(report).toMatchObject({ blocked: 1, claimed: 0 });
    expect(await store.jobs.get("r1")).toMatchObject({ state: "pending", attempts: 0 });
    expect(report.jobs[0]?.note).toContain("indexer runtime is not configured");
  });
});

describe("index worker orchestration", () => {
  test("drains on start and reschedules itself without real timers", async () => {
    const store = createInMemoryMemoryStore();
    const memory = createMemory({
      store,
      indexer: () => fakeIndexerRuntime([{ text: "n" }]).runtime,
    });
    await memory.enqueue(run({ run_id: "r1" }));
    const clock = createTestClock();
    const worker = createIndexWorker({ resolve: () => memory, clock, intervalMs: 60_000 });

    worker.start();
    await settle();

    expect((await store.jobs.get("r1"))?.state).toBe("completed");
    expect(clock.pending()).toBe(1);
    await worker.stop();
    expect(clock.pending()).toBe(0);
  });

  test("coalesces a burst of pokes into at most one follow-up pass", async () => {
    const store = createInMemoryMemoryStore();
    let drains = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const memory: Memory = {
      ...createMemory({ store }),
      async drain() {
        drains += 1;
        if (drains === 1) await gate;
        return { claimed: 0, completed: 0, retried: 0, failed: 0, blocked: 0, jobs: [] };
      },
    };
    const clock = createTestClock();
    const worker = createIndexWorker({ resolve: () => memory, clock });

    worker.start();
    await Promise.resolve();
    worker.poke();
    worker.poke();
    worker.poke();
    release?.();
    await settle();

    expect(drains).toBe(2);
    await worker.stop();
  });
});
