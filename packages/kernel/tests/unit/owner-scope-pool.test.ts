import { describe, expect, test } from "bun:test";
import { createOwnerScopePool, type OwnerScopeClock } from "#src/core/owner-scope-pool.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function controlledClock() {
  let time = 0;
  const timers: { due: number; fire(): void; cancelled: boolean; unrefed: boolean }[] = [];
  const clock: OwnerScopeClock = {
    now: () => time,
    schedule(delay, callback) {
      const timer = { due: time + delay, fire: callback, cancelled: false, unrefed: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
        unref: () => {
          timer.unrefed = true;
        },
      };
    },
  };
  return {
    clock,
    timers,
    advance(ms: number) {
      time += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.due <= time) {
          timer.cancelled = true;
          timer.fire();
        }
      }
    },
  };
}

describe("owner scope pool", () => {
  test("last release starts an unrefed idle timer and reacquisition cancels it", async () => {
    const time = controlledClock();
    const retired: number[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 2,
      idleMs: 10,
      clock: time.clock,
      isOpen: () => true,
      build: (_owner: string, generation: number) => generation,
      retire: async (_owner, generation) => void retired.push(generation),
      observeRetirement: (promise) => void promise.catch(() => undefined),
    });
    const first = await pool.acquire("alice");
    first.release();
    first.release();
    expect(time.timers).toHaveLength(1);
    expect(time.timers[0]!.unrefed).toBeTrue();
    time.advance(5);
    const again = await pool.acquire("alice");
    expect(again.value).toBe(first.value);
    expect(time.timers[0]!.cancelled).toBeTrue();
    time.timers[0]!.fire();
    expect(retired).toEqual([]);
    again.release();
    time.advance(10);
    await pool.close();
    expect(retired).toEqual([first.value]);
  });

  test("pins and run references block idle retirement; shutdown waits for run closure", async () => {
    const time = controlledClock();
    const retired: string[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 3,
      idleMs: 0,
      clock: time.clock,
      isOpen: () => true,
      build: (owner: string, generation: number) => ({ owner, generation }),
      retire: async (owner) => void retired.push(owner),
      observeRetirement: (promise) => void promise.catch(() => undefined),
    });
    pool.resident("fixed", true);
    const lease = await pool.acquire("active");
    const releaseRun = pool.retainRun("active", lease.value.generation);
    lease.release();
    expect(pool.hasActiveRuns()).toBeTrue();
    expect(retired).toEqual([]);
    let finished = false;
    const closing = pool.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBeFalse();
    releaseRun();
    releaseRun();
    await closing;
    expect(retired.sort()).toEqual(["active", "fixed"]);
    expect(pool.hasActiveRuns()).toBeFalse();
    expect(() => pool.resident("late", false)).toThrow("kernel is closing");
  });

  test("a failed start releases its run reference and a terminal result waits for handle closure", async () => {
    const closed = deferred();
    const retired: number[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 2,
      idleMs: 0,
      isOpen: () => true,
      build: (_owner: string, generation: number) => generation,
      retire: async (_owner, generation) => void retired.push(generation),
      observeRetirement: (promise) => void promise.catch(() => undefined),
    });
    const first = pool.resident("alice", false);
    await expect(
      pool.startRun("alice", first, () => Promise.reject(new Error("start failed"))),
    ).rejects.toThrow("start failed");
    expect(pool.hasActiveRuns()).toBeFalse();
    const next = await pool.acquire("alice");
    expect(next.value).not.toBe(first);
    const handle = await pool.startRun("alice", next.value, async () => ({
      result: Promise.resolve("terminal"),
      closed: closed.promise,
    }));
    next.release();
    await handle.result;
    expect(pool.hasActiveRuns()).toBeTrue();
    expect(retired).toEqual([first]);
    closed.resolve();
    await handle.closed;
    await pool.close();
    expect(retired).toEqual([first, next.value]);
  });

  test("retiring owners occupy capacity and their next generation waits for cleanup", async () => {
    const cleanup = deferred();
    const builds: number[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 2,
      idleMs: 0,
      isOpen: () => true,
      build: (_owner: string, generation: number) => {
        builds.push(generation);
        return generation;
      },
      retire: (owner) => (owner === "alice" ? cleanup.promise : Promise.resolve()),
      observeRetirement: (promise) => void promise.catch(() => undefined),
    });
    pool.resident("fixed", true);
    const alice = await pool.acquire("alice");
    alice.release();
    expect(() => pool.resident("bob", false)).toThrow("cache is full");
    const replacement = pool.acquire("alice");
    expect(builds).toHaveLength(2);
    cleanup.resolve();
    const next = await replacement;
    expect(next.value).not.toBe(alice.value);
    next.release();
    await pool.close();
  });

  test("failed retirement rejects a waiting acquisition while its observer handles detached failure", async () => {
    const cleanup = deferred();
    const observed: unknown[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 2,
      idleMs: 0,
      isOpen: () => true,
      build: (_owner: string, generation: number) => generation,
      retire: () => cleanup.promise,
      observeRetirement: (promise) => void promise.catch((error: unknown) => observed.push(error)),
    });
    const first = await pool.acquire("alice");
    first.release();
    const waiting = pool.acquire("alice");
    cleanup.reject(new Error("cleanup failed"));
    await expect(waiting).rejects.toThrow("cleanup failed");
    expect(observed).toHaveLength(1);
    await pool.close();
  });

  test("a delayed callback from an old generation cannot retire a rebuilt owner", async () => {
    const time = controlledClock();
    const retired: number[] = [];
    const pool = createOwnerScopePool({
      maxOwners: 2,
      idleMs: 10,
      clock: time.clock,
      isOpen: () => true,
      build: (_owner: string, generation: number) => generation,
      retire: async (_owner, generation) => void retired.push(generation),
      observeRetirement: (promise) => void promise.catch(() => undefined),
    });
    const first = await pool.acquire("alice");
    first.release();
    const oldTimer = time.timers[0]!;
    time.advance(10);
    const rebuilt = await pool.acquire("alice");
    oldTimer.fire();
    expect(pool.isCurrent("alice", rebuilt.value)).toBeTrue();
    expect(retired).toEqual([first.value]);
    rebuilt.release();
    await pool.close();
  });
});
