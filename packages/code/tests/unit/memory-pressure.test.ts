import { describe, expect, test } from "bun:test";
import {
  createMemoryPressureController,
  DEFAULT_TUI_RSS_LIMIT_BYTES,
  MIN_TUI_RSS_LIMIT_BYTES,
  memoryPressureAllowsSlash,
  MEMORY_PRESSURE_EPISODE_TIMEOUT_MS,
  MEMORY_PRESSURE_SAMPLE_MS,
  MEMORY_PRESSURE_STATUS_FAILED,
  MEMORY_PRESSURE_STATUS_RESTORING,
  MEMORY_PRESSURE_STEP_TIMEOUT_MS,
  MIB,
  tuiRssLimitBytes,
  type MemoryMaintenanceReport,
  type ProcessMemorySample,
} from "../../src/adapters/memory-pressure.ts";

const memory = (rss: number): ProcessMemorySample => ({
  rss,
  heapUsed: Math.floor(rss / 2),
  external: 10,
  arrayBuffers: 5,
});

const report = (over: Partial<MemoryMaintenanceReport> = {}): MemoryMaintenanceReport => ({
  attempted: ["transcript.reconstructible_tools"],
  completed: true,
  pending: false,
  before: { hydrated_tool_nodes: 4 },
  after: { hydrated_tool_nodes: 0 },
  ...over,
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("the interactive TUI RSS controller", () => {
  test("defaults to 2 GiB, accepts MiB and uses zero as an explicit opt-out", () => {
    expect(tuiRssLimitBytes(undefined)).toBe(DEFAULT_TUI_RSS_LIMIT_BYTES);
    expect(tuiRssLimitBytes("   ")).toBe(DEFAULT_TUI_RSS_LIMIT_BYTES);
    expect(tuiRssLimitBytes("2048")).toBe(2048 * MIB);
    expect(tuiRssLimitBytes("5120")).toBe(5120 * MIB);
    expect(tuiRssLimitBytes("64")).toBe(MIN_TUI_RSS_LIMIT_BYTES);
    expect(tuiRssLimitBytes("0.25")).toBe(MIN_TUI_RSS_LIMIT_BYTES);
    expect(tuiRssLimitBytes("0")).toBe(0);
    expect(tuiRssLimitBytes("-1")).toBe(DEFAULT_TUI_RSS_LIMIT_BYTES);
    expect(tuiRssLimitBytes("invalid")).toBe(DEFAULT_TUI_RSS_LIMIT_BYTES);
  });

  test("keeps clear/quit available while work is blocked and drops recover-memory", () => {
    expect(memoryPressureAllowsSlash("clear")).toBe(true);
    expect(memoryPressureAllowsSlash("quit")).toBe(true);
    expect(memoryPressureAllowsSlash("exit")).toBe(true);
    expect(memoryPressureAllowsSlash("recover-memory")).toBe(false);
    expect(memoryPressureAllowsSlash("new")).toBe(false);
    expect(memoryPressureAllowsSlash("export")).toBe(false);
  });

  test("ignores a transient warning sample and starts one silent maintain pass after sustained pressure", async () => {
    let rss = 0;
    let maintains = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      maintain: () => {
        maintains += 1;
        return report();
      },
    });

    rss = 800;
    expect(controller.sampleNow().phase).toBe("armed");
    expect(controller.blocked()).toBe(false);
    expect(controller.sampleNow().phase).toBe("armed");
    expect(maintains).toBe(0);
    expect(controller.sampleNow().phase).toBe("maintaining");
    expect(controller.blocked()).toBe(false);
    expect(controller.state().status).toBeNull();
    await flush();
    expect(maintains).toBe(1);
    controller.sampleNow();
    expect(maintains).toBe(1);
  });

  test("growth below the fuse is diagnostic only and never maintains or blocks", () => {
    let rss = 160 * MIB;
    let maintains = 0;
    let ledgers = 0;
    const controller = createMemoryPressureController({
      limitBytes: 2048 * MIB,
      sample: () => memory(rss),
      maintain: () => {
        maintains += 1;
        return report();
      },
      ledgerEnabled: () => true,
      ledger: () => {
        ledgers += 1;
        return { transcript_nodes: 3 };
      },
    });

    controller.sampleNow();
    for (let i = 1; i < 20; i += 1) {
      rss = (160 + i * 24) * MIB;
      controller.sampleNow();
    }
    expect(controller.state()).toMatchObject({ phase: "armed", advisory: true, blocked: false });
    expect(maintains).toBe(0);
    expect(ledgers).toBeGreaterThan(0);
  });

  test("does not collect the aggregate ledger while diagnostics are disabled", () => {
    let ledgers = 0;
    const controller = createMemoryPressureController({
      limitBytes: 2048 * MIB,
      sample: () => memory(160 * MIB),
      ledgerEnabled: () => false,
      ledger: () => {
        ledgers += 1;
        return {};
      },
    });

    for (let i = 0; i < 40; i += 1) controller.sampleNow();
    expect(ledgers).toBe(0);
  });

  test("critical pressure blocks admission, maintains once, and rearms after three safe samples", async () => {
    let rss = 1_000;
    let maintains = 0;
    let collections = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      maintain: () => {
        maintains += 1;
        return report();
      },
      gc: () => {
        collections += 1;
      },
    });

    expect(controller.sampleNow()).toMatchObject({
      phase: "critical",
      blocked: true,
      status: MEMORY_PRESSURE_STATUS_RESTORING,
    });
    await flush();
    expect(maintains).toBe(1);
    expect(collections).toBe(1);

    rss = 600;
    controller.sampleNow();
    expect(controller.state().phase).toBe("cooling");
    controller.sampleNow();
    expect(controller.state().phase).toBe("cooling");
    expect(controller.sampleNow()).toMatchObject({ phase: "armed", blocked: false, status: null });
    expect(maintains).toBe(1);
  });

  test("a natural RSS drop rearms without a second maintain pass", async () => {
    let rss = 800;
    let maintains = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      maintain: () => {
        maintains += 1;
        return report();
      },
    });

    controller.sampleNow();
    controller.sampleNow();
    expect(controller.sampleNow().phase).toBe("maintaining");
    await flush();
    rss = 100;
    controller.sampleNow();
    controller.sampleNow();
    expect(controller.sampleNow().phase).toBe("armed");
    expect(controller.blocked()).toBe(false);
    expect(maintains).toBe(1);
  });

  test("skips GC while TUI-owned work is still settling", async () => {
    let collections = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(1_000),
      canCollect: () => false,
      gc: () => {
        collections += 1;
      },
    });

    expect(controller.sampleNow().phase).toBe("critical");
    await flush();
    expect(collections).toBe(0);
  });

  test("a pending maintain keeps its identity after timeout and never starts a second pass", async () => {
    let rss = 1_000;
    let maintains = 0;
    let scheduledDelay = 0;
    let fireTimeout: (() => void) | undefined;
    const maintain = deferred<MemoryMaintenanceReport>();
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      maintain: () => {
        maintains += 1;
        return maintain.promise;
      },
      setAfter: (callback, delayMs) => {
        fireTimeout = callback;
        scheduledDelay = delayMs;
        return {};
      },
      clearAfter: () => {},
    });

    expect(controller.sampleNow().phase).toBe("critical");
    await flush();
    expect(maintains).toBe(1);
    expect(scheduledDelay).toBe(MEMORY_PRESSURE_STEP_TIMEOUT_MS);
    fireTimeout?.();
    expect(controller.state().phase).toBe("critical");
    controller.sampleNow();
    expect(maintains).toBe(1);

    rss = 1;
    maintain.resolve(report({ pending: true }));
    await flush();
    expect(controller.state().phase).toBe("cooling");
    expect(maintains).toBe(1);
  });

  test("a late callback after stop does not mutate a new generation", async () => {
    const maintain = deferred<MemoryMaintenanceReport>();
    let collections = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(1_000),
      maintain: () => maintain.promise,
      gc: () => {
        collections += 1;
      },
    });

    expect(controller.sampleNow().phase).toBe("critical");
    await flush();
    controller.stop();
    maintain.resolve(report());
    await flush();
    expect(controller.state().phase).toBe("critical");
    expect(collections).toBe(0);
  });

  test("a maintain exception during critical fails closed without retrying", async () => {
    let maintains = 0;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(100),
      maintain: () => {
        maintains += 1;
        throw new Error("store closed");
      },
    });

    expect(controller.sampleNow().phase).toBe("critical");
    await flush();
    expect(controller.state()).toMatchObject({
      phase: "failed",
      blocked: true,
      status: MEMORY_PRESSURE_STATUS_FAILED,
    });
    controller.sampleNow();
    await flush();
    expect(maintains).toBe(1);
  });

  test("a permanently high RSS fails the critical episode instead of waiting forever", () => {
    let clock = 0;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(100),
      now: () => clock,
    });

    expect(controller.sampleNow().phase).toBe("critical");
    clock = MEMORY_PRESSURE_EPISODE_TIMEOUT_MS - 1;
    expect(controller.sampleNow().phase).toBe("critical");
    clock = MEMORY_PRESSURE_EPISODE_TIMEOUT_MS;
    expect(controller.sampleNow().phase).toBe("failed");
  });

  test("a later safe RSS drop unblocks a measured failure that did not lose integrity", async () => {
    let clock = 0;
    let rss = 100;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(rss),
      now: () => clock,
    });

    controller.sampleNow();
    await flush();
    clock = MEMORY_PRESSURE_EPISODE_TIMEOUT_MS;
    expect(controller.sampleNow().phase).toBe("failed");
    rss = 1;
    controller.sampleNow();
    controller.sampleNow();
    expect(controller.sampleNow()).toMatchObject({ phase: "armed", blocked: false });
  });

  test("the sampler is 500ms, unrefed and stopped explicitly", () => {
    let delay = 0;
    let unrefs = 0;
    let clears = 0;
    const handle = { unref: () => (unrefs += 1) };
    const controller = createMemoryPressureController({
      sample: () => memory(1),
      setEvery: (_callback, ms) => {
        delay = ms;
        return handle;
      },
      clearEvery: (seen) => {
        expect(seen).toBe(handle);
        clears += 1;
      },
    });
    controller.start();
    expect(delay).toBe(MEMORY_PRESSURE_SAMPLE_MS);
    expect(unrefs).toBe(1);
    controller.stop();
    expect(clears).toBe(1);
  });

  test("a disabled fuse samples on demand but never installs a timer", () => {
    let timers = 0;
    const controller = createMemoryPressureController({
      limitBytes: 0,
      sample: () => memory(123),
      setEvery: () => {
        timers += 1;
        return {};
      },
    });

    controller.start();
    expect(controller.sampleNow()).toMatchObject({ phase: "disabled", rss: 123, blocked: false });
    expect(timers).toBe(0);
    controller.stop();
  });

  test("tolerates a throwing GC and does not reconnect or cancel work", async () => {
    let maintains = 0;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(100),
      maintain: () => {
        maintains += 1;
        return report();
      },
      gc: () => {
        throw new Error("explicit GC disabled");
      },
    });

    expect(controller.sampleNow().phase).toBe("critical");
    await flush();
    expect(maintains).toBe(1);
    expect(controller.blocked()).toBe(true);
  });
});
