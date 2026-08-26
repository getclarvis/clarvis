import { describe, expect, spyOn, test } from "bun:test";
import * as capability from "@clarvis/capability";

import type { MemoryDrainReport } from "../../src/drain.ts";
import { createTestClock } from "../../src/testing.ts";
import type { Memory } from "../../src/memory-contract.ts";
import { createIndexWorker } from "../../src/worker.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";

const emptyReport = (): MemoryDrainReport => ({
  claimed: 0,
  completed: 0,
  retried: 0,
  failed: 0,
  blocked: 0,
  jobs: [],
});

/** A `Memory` stub exposing only what the worker touches. */
function drainOnly(drain: () => Promise<MemoryDrainReport>): Memory {
  return { drain } as unknown as Memory;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createIndexWorker", () => {
  test("keeps its timer armed through a tick where nothing resolves", async () => {
    const clock = createTestClock();
    let resolvable = false;
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      return emptyReport();
    });

    const worker = createIndexWorker({
      resolve: () => (resolvable ? memory : undefined),
      clock,
      intervalMs: 1000,
    });

    worker.start();
    await Promise.resolve();
    expect(drains).toBe(0);
    expect(clock.pending()).toBe(1);

    resolvable = true;
    await clock.advance(1000);
    expect(drains).toBe(1);

    await worker.stop();
  });

  test("keeps its timer armed after a drain that throws", async () => {
    const clock = createTestClock();
    const log = recordingLogger();
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      throw new Error("the store is wedged");
    });

    const worker = createIndexWorker({
      resolve: () => memory,
      clock,
      intervalMs: 1000,
      logger: log.logger,
    });

    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(drains).toBe(1);
    expect(log.one("memory.drain.failed").fields.cause).toContain("the store is wedged");
    expect(clock.pending()).toBe(1);

    await clock.advance(1000);
    expect(drains).toBe(2);

    await worker.stop();
  });

  test("settles and observes the pass even when failure logging itself throws", async () => {
    const clock = createTestClock();
    const worker = createIndexWorker({
      resolve: () =>
        drainOnly(async () => {
          throw new Error("drain failed");
        }),
      clock,
      intervalMs: 1000,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error("logger failed");
        },
        error: () => {},
      },
    });

    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pending()).toBe(1);
    await worker.stop();
  });

  test("stop observes an in-flight pass whose failure reporter also throws", async () => {
    const worker = createIndexWorker({
      resolve: () =>
        drainOnly(async () => {
          throw new Error("drain failed");
        }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error("logger failed");
        },
        error: () => {},
      },
    });

    worker.start();
    await worker.stop();
  });

  test("observes one pass, not one Promise reaction per poke in a large storm", async () => {
    const clock = createTestClock();
    const firstDrain = deferred();
    const secondDrainStarted = deferred();
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      if (drains === 1) await firstDrain.promise;
      if (drains === 2) secondDrainStarted.resolve();
      return emptyReport();
    });
    const observed = spyOn(capability, "detachObserved");
    const worker = createIndexWorker({ resolve: () => memory, clock });

    try {
      worker.start();
      await Promise.resolve();
      for (let index = 0; index < 100_000; index += 1) worker.poke();

      expect(drains).toBe(1);
      expect(observed).toHaveBeenCalledTimes(1);

      firstDrain.resolve();
      await secondDrainStarted.promise;
      expect(drains).toBe(2);
      expect(observed).toHaveBeenCalledTimes(2);
      expect(observed.mock.calls.map(([, options]) => options.operation)).toEqual([
        "memory_worker_start",
        "memory_worker_followup",
      ]);
    } finally {
      await worker.stop();
      observed.mockRestore();
    }
  });

  test("does not leave an interval timer armed behind a slow immediate follow-up", async () => {
    const clock = createTestClock();
    const firstDrain = deferred();
    const secondDrain = deferred();
    const secondDrainStarted = deferred();
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      if (drains === 1) await firstDrain.promise;
      if (drains === 2) {
        secondDrainStarted.resolve();
        await secondDrain.promise;
      }
      return emptyReport();
    });
    const worker = createIndexWorker({ resolve: () => memory, clock, intervalMs: 1000 });

    worker.start();
    await Promise.resolve();
    worker.poke();

    firstDrain.resolve();
    await secondDrainStarted.promise;
    expect(drains).toBe(2);
    expect(clock.pending()).toBe(0);

    // The immediate follow-up remains in flight beyond a whole interval. There
    // is no stale timer to turn that elapsed interval into a third drain.
    await clock.advance(1000);
    expect(drains).toBe(2);

    secondDrain.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drains).toBe(2);
    expect(clock.pending()).toBe(1);

    await worker.stop();
    expect(clock.pending()).toBe(0);
  });

  test("stop() disarms the timer, so an unresolvable tick cannot revive it", async () => {
    const clock = createTestClock();
    const worker = createIndexWorker({
      resolve: () => undefined,
      clock,
      intervalMs: 1000,
    });

    worker.start();
    await Promise.resolve();
    expect(clock.pending()).toBe(1);

    await worker.stop();
    expect(clock.pending()).toBe(0);

    await clock.advance(5000);
    expect(clock.pending()).toBe(0);
  });

  test("waits the interval on a pass that only blocked, whose due time is already past", async () => {
    const clock = createTestClock();
    const log = recordingLogger();
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      return {
        ...emptyReport(),
        blocked: 1,
        jobs: [
          {
            run_id: "stuck",
            outcome: "blocked" as const,
            note: "the indexer runtime is not configured",
          },
        ],
        // A blocked job stays `pending`, so the queue reports it due at the
        // instant it was enqueued — permanently in the past.
        next_due_at: clock.now() - 5_000,
      };
    });

    const worker = createIndexWorker({
      resolve: () => memory,
      clock,
      intervalMs: 1000,
      logger: log.logger,
    });

    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(drains).toBe(1);

    await clock.advance(999);
    expect(drains).toBe(1);
    await clock.advance(1);
    expect(drains).toBe(2);
    expect(log.of("memory.drain.pass")).toHaveLength(1);

    await worker.stop();
  });

  test("still wakes early for a job that is genuinely retrying", async () => {
    const clock = createTestClock();
    let drains = 0;
    const memory = drainOnly(async () => {
      drains += 1;
      return {
        ...emptyReport(),
        claimed: 1,
        retried: 1,
        jobs: [{ run_id: "r1", outcome: "retry_wait" as const }],
        next_due_at: clock.now() + 50,
      };
    });

    const worker = createIndexWorker({ resolve: () => memory, clock, intervalMs: 1000 });
    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(drains).toBe(1);

    await clock.advance(50);
    expect(drains).toBe(2);

    await worker.stop();
  });

  test("reports settled jobs and survives a listener that throws", async () => {
    const clock = createTestClock();
    const seen: string[] = [];
    const memory = drainOnly(async () => ({
      ...emptyReport(),
      completed: 1,
      jobs: [{ run_id: "r1", outcome: "completed" as const }],
      next_due_at: clock.now() + 250,
    }));

    const worker = createIndexWorker({
      resolve: () => memory,
      clock,
      intervalMs: 1000,
      onJobSettled: (outcome) => {
        seen.push(outcome.run_id);
        throw new Error("a listener must not break the worker");
      },
    });

    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["r1"]);
    expect(clock.pending()).toBe(1);

    await worker.stop();
  });
});
