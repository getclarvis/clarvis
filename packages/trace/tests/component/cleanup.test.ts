import { describe, it, expect, vi } from "bun:test";
import { TraceCleanup, type TraceCleanupCounters, type TraceStore } from "@clarvis/trace";
import type { Logger } from "@clarvis/capability";
import { createMemoryTraceStore } from "../../src/testing.ts";
import { makeExecutionRecord } from "../helpers/execution-record.ts";

const DAY = 86_400_000;

function freshStore(): TraceStore {
  return createMemoryTraceStore();
}

function captureLogger(): {
  logger: Logger;
  info: { obj: unknown; msg: unknown }[];
  error: { obj: unknown; msg: unknown }[];
} {
  const info: { obj: unknown; msg: unknown }[] = [];
  const error: { obj: unknown; msg: unknown }[] = [];
  const logger = {
    info: (obj: unknown, msg: unknown) => void info.push({ obj, msg }),
    error: (obj: unknown, msg: unknown) => void error.push({ obj, msg }),
  } as unknown as Logger;
  return { logger, info, error };
}

function fakeStore(impl: () => number): { store: TraceStore; calls: [number, number][] } {
  const calls: [number, number][] = [];
  const store = {
    cleanup(cutoffMs: number, batch: number): number {
      calls.push([cutoffMs, batch]);
      return impl();
    },
  } as unknown as TraceStore;
  return { store, calls };
}

/** A store whose sweep removes exactly one artifact of each named kind. */
function countingStore(): TraceStore {
  return {
    cleanup(_cutoffMs: number, _batch: number, counters?: TraceCleanupCounters): number {
      if (counters === undefined) return 0;
      counters.records += 2;
      counters.journals += 1;
      counters.leases += 3;
      return 6;
    },
  } as unknown as TraceStore;
}

describe("TTL cleanup", () => {
  it("purges executions older than the TTL regardless of owner; keeps recent ones", async () => {
    const store = freshStore();
    const now = Date.now();
    await store.insert(
      makeExecutionRecord({ id: "old-alice", owner_key_name: "alice", started_at: now - 2 * DAY }),
    );
    await store.insert(
      makeExecutionRecord({ id: "old-bob", owner_key_name: "bob", started_at: now - 3 * DAY }),
    );
    await store.insert(
      makeExecutionRecord({ id: "fresh", owner_key_name: "alice", started_at: now - 60_000 }),
    );

    const cleanup = new TraceCleanup({ store, ttlDays: 1, batchSize: 1000 });
    const deleted = cleanup.runOnce();

    expect(deleted).toBe(2);
    expect(store.getById("alice", "old-alice")).toBeNull();
    expect(store.getById("bob", "old-bob")).toBeNull();
    expect(store.getById("alice", "fresh")).not.toBeNull();
  });

  it("keeps an expired execution while a durable session references it", async () => {
    const store = freshStore();
    const now = Date.now();
    await store.insert(
      makeExecutionRecord({ id: "kept", owner_key_name: "alice", started_at: now - 5 * DAY }),
    );
    await store.insert(
      makeExecutionRecord({ id: "orphan", owner_key_name: "alice", started_at: now - 5 * DAY }),
    );

    const cleanup = new TraceCleanup({
      store,
      ttlDays: 1,
      batchSize: 1000,
      protectedExecutionIds: () => ({ ids: new Set(["kept"]), complete: true }),
    });

    expect(cleanup.runOnce()).toBe(1);
    expect(store.getById("alice", "kept")).not.toBeNull();
    expect(store.getById("alice", "orphan")).toBeNull();
  });

  it("skips destructive cleanup when session-reference discovery is incomplete", async () => {
    const store = freshStore();
    await store.insert(
      makeExecutionRecord({
        id: "kept",
        owner_key_name: "alice",
        started_at: Date.now() - 5 * DAY,
      }),
    );
    const cleanup = new TraceCleanup({
      store,
      ttlDays: 1,
      batchSize: 1000,
      protectedExecutionIds: () => ({ ids: new Set(), complete: false }),
    });

    expect(cleanup.runOnce()).toBe(0);
    expect(store.getById("alice", "kept")).not.toBeNull();
  });

  it("drains a backlog larger than batchSize within a single runOnce", async () => {
    const store = freshStore();
    const now = Date.now();
    for (let i = 0; i < 25; i += 1) {
      await store.insert(
        makeExecutionRecord({ id: `old-${i}`, owner_key_name: "alice", started_at: now - 5 * DAY }),
      );
    }
    await store.insert(
      makeExecutionRecord({ id: "fresh", owner_key_name: "alice", started_at: now - 60_000 }),
    );

    const cleanup = new TraceCleanup({ store, ttlDays: 1, batchSize: 10 });
    const deleted = cleanup.runOnce();

    expect(deleted).toBe(25);
    expect(store.list("alice", 100, 0).total).toBe(1);
    expect(store.getById("alice", "fresh")).not.toBeNull();
  });

  it("runs an immediate purge on start() so short sessions still enforce the TTL", async () => {
    const store = freshStore();
    const now = Date.now();
    await store.insert(
      makeExecutionRecord({ id: "stale", owner_key_name: "alice", started_at: now - 5 * DAY }),
    );
    const cleanup = new TraceCleanup({ store, ttlDays: 1, batchSize: 1000 });
    cleanup.start(3_600_000);
    cleanup.stop();
    expect(store.getById("alice", "stale")).toBeNull();
  });

  it("swallows a store.cleanup() throw (best-effort) instead of crashing the process", () => {
    let calls = 0;
    const throwingStore = {
      cleanup(): number {
        calls += 1;
        throw new Error("EIO: i/o error during cleanup");
      },
    } as unknown as TraceStore;
    const cleanup = new TraceCleanup({ store: throwingStore, ttlDays: 1, batchSize: 1000 });
    expect(() => cleanup.runOnce()).not.toThrow();
    expect(cleanup.runOnce()).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("TraceCleanup — scheduling and pass behavior", () => {
  it("ttlDays=0 disables start() and runOnce() entirely", () => {
    const { store, calls } = fakeStore(() => 3);
    const c = new TraceCleanup({ store, ttlDays: 0, batchSize: 10 });
    c.start(1000);
    expect(c.runOnce()).toBe(0);
    expect(calls).toHaveLength(0);
    c.stop();
  });

  it("runs immediately then on each interval tick, and stop() halts further passes", () => {
    vi.useFakeTimers();
    try {
      const { store, calls } = fakeStore(() => 1);
      const { logger, info } = captureLogger();
      const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5, logger });
      c.start(1000);
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(3000);
      expect(calls.length).toBe(4);
      c.stop();
      vi.advanceTimersByTime(5000);
      expect(calls.length).toBe(4);
      expect(info.length).toBe(4);
      expect((info[0]!.obj as { deleted: number }).deleted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent while already running", () => {
    vi.useFakeTimers();
    try {
      const { store, calls } = fakeStore(() => 0);
      const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5 });
      c.start(1000);
      c.start(1000);
      expect(calls).toHaveLength(1);
      c.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a sub-1ms interval to 1ms", () => {
    vi.useFakeTimers();
    try {
      const { store, calls } = fakeStore(() => 0);
      const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5 });
      c.start(0);
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(calls.length).toBe(3);
      c.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not log when nothing was deleted", () => {
    const { store } = fakeStore(() => 0);
    const { logger, info } = captureLogger();
    const c = new TraceCleanup({ store, ttlDays: 2, batchSize: 5, logger });
    expect(c.runOnce()).toBe(0);
    expect(info).toHaveLength(0);
  });

  it("swallows a failing pass, logs the cause, and returns 0", () => {
    const { store } = fakeStore(() => {
      throw new Error("db gone");
    });
    const { logger, error } = captureLogger();
    const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5, logger });
    expect(c.runOnce()).toBe(0);
    expect(error).toHaveLength(1);
    expect((error[0]!.obj as { cause: string }).cause).toBe("db gone");
  });

  it("stringifies a non-Error failure cause", () => {
    const { store } = fakeStore(() => {
      throw "raw failure";
    });
    const { logger, error } = captureLogger();
    const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5, logger });
    expect(c.runOnce()).toBe(0);
    expect((error[0]!.obj as { cause: string }).cause).toBe("raw failure");
  });

  it("stop() is safe when never started", () => {
    const { store } = fakeStore(() => 0);
    const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 5 });
    expect(() => c.stop()).not.toThrow();
  });

  it("normalizes a non-positive batchSize to 1 instead of spinning the full pass cap", () => {
    const { store, calls } = fakeStore(() => 0);
    const warn: { obj: unknown; msg: unknown }[] = [];
    const logger = {
      warn: (obj: unknown, msg: unknown) => void warn.push({ obj, msg }),
    } as unknown as Logger;
    const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 0, logger });

    expect(c.runOnce()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe(1);
    expect(warn).toHaveLength(0);
  });

  it("floors a fractional batchSize to a positive integer", () => {
    const { store, calls } = fakeStore(() => 0);
    const c = new TraceCleanup({ store, ttlDays: 1, batchSize: 0.5 });
    expect(c.runOnce()).toBe(0);
    expect(calls[0]![1]).toBe(1);
  });

  it("hard-caps non-finite programmatic cleanup bounds", () => {
    const { store, calls } = fakeStore(() => 0);
    const c = new TraceCleanup({
      store,
      ttlDays: 1,
      batchSize: Number.POSITIVE_INFINITY,
      maxEntriesPerRun: Number.NaN,
    });
    expect(c.runOnce()).toBe(0);
    expect(calls[0]![1]).toBe(10_000);
  });

  it("warns and bails out when a full-batch backlog exceeds the per-run pass cap", () => {
    const batchSize = 5;
    const { store, calls } = fakeStore(() => batchSize);
    const warn: { obj: unknown; msg: unknown }[] = [];
    const logger = {
      warn: (obj: unknown, msg: unknown) => void warn.push({ obj, msg }),
    } as unknown as Logger;
    const c = new TraceCleanup({
      store,
      ttlDays: 1,
      batchSize,
      maxEntriesPerRun: 25,
      logger,
    });

    const deleted = c.runOnce();

    expect(calls.length).toBe(5);
    expect(deleted).toBe(25);
    expect(warn).toHaveLength(1);
    expect(String(warn[0]!.msg)).toContain("per-run pass cap");
    expect((warn[0]!.obj as { max_passes: number }).max_passes).toBe(5);
  });
});

describe("what a cleanup pass reports", () => {
  it("splits journals and leases out of the deleted total", () => {
    const { logger, info } = captureLogger();

    const deleted = new TraceCleanup({
      store: countingStore(),
      ttlDays: 1,
      batchSize: 1000,
      logger,
    }).runOnce();

    expect(deleted).toBe(6);
    expect(info).toHaveLength(1);
    expect(info[0]!.obj).toMatchObject({
      deleted: 6,
      journals_removed: 1,
      leases_reclaimed: 3,
      ttl_days: 1,
    });
  });
});
