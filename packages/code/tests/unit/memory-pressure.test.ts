import { describe, expect, test } from "bun:test";
import {
  createMemoryPressureController,
  DEFAULT_TUI_RSS_LIMIT_BYTES,
  MIN_TUI_RSS_LIMIT_BYTES,
  memoryPressureAllowsSlash,
  MEMORY_PRESSURE_ABORT_GRACE_MS,
  MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS,
  MEMORY_PRESSURE_SAMPLE_MS,
  MIB,
  tuiRssLimitBytes,
  type ProcessMemorySample,
} from "../../src/adapters/memory-pressure.ts";

const memory = (rss: number): ProcessMemorySample => ({
  rss,
  heapUsed: Math.floor(rss / 2),
  external: 10,
  arrayBuffers: 5,
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("the interactive TUI RSS fuse", () => {
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

  test("keeps the real clear/recovery/quit slashes available while work is blocked", () => {
    expect(memoryPressureAllowsSlash("clear")).toBe(true);
    expect(memoryPressureAllowsSlash("recover-memory")).toBe(true);
    expect(memoryPressureAllowsSlash("quit")).toBe(true);
    expect(memoryPressureAllowsSlash("exit")).toBe(true);
    expect(memoryPressureAllowsSlash("new")).toBe(false);
    expect(memoryPressureAllowsSlash("export")).toBe(false);
  });

  test("warns at 80%, aborts once at the limit and remains alive in tripped state", () => {
    let rss = 0;
    let active = true;
    let cancels = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      isRunActive: () => active,
      cancelRun: () => {
        cancels += 1;
        return true;
      },
      reconnect: async () => ({ ok: true, message: "ok" }),
    });

    rss = 800;
    expect(controller.sampleNow().phase).toBe("warning");
    rss = 1_000;
    expect(controller.sampleNow().phase).toBe("aborting");
    expect(cancels).toBe(1);
    expect(controller.blocked()).toBe(true);
    controller.sampleNow();
    expect(cancels).toBe(1);
    active = false;
    expect(controller.sampleNow().phase).toBe("tripped");
    expect(controller.state().rss).toBe(1_000);
  });

  test("raises a separate slope advisory and emits a bounded aggregate ledger", () => {
    let rss = 160 * MIB;
    let ledgers = 0;
    const controller = createMemoryPressureController({
      limitBytes: 2048 * MIB,
      sample: () => memory(rss),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: true, message: "ok" }),
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
    expect(controller.state()).toMatchObject({ phase: "armed", advisory: true });
    expect(ledgers).toBeGreaterThan(0);

    for (let i = 0; i < 20; i += 1) controller.sampleNow();
    expect(controller.state().advisory).toBe(false);
  });

  test("does not collect the aggregate ledger while diagnostics are disabled", () => {
    let ledgers = 0;
    const controller = createMemoryPressureController({
      limitBytes: 2048 * MIB,
      sample: () => memory(160 * MIB),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: true, message: "ok" }),
      ledgerEnabled: () => false,
      ledger: () => {
        ledgers += 1;
        return {};
      },
    });

    for (let i = 0; i < 40; i += 1) controller.sampleNow();
    expect(ledgers).toBe(0);
  });

  test("explicit recovery reconnects, runs GC and rearms after three safe samples", async () => {
    let rss = 1_000;
    let reconnects = 0;
    let collections = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => {
        reconnects += 1;
        return { ok: true, message: "rebuilt" };
      },
      gc: () => {
        collections += 1;
      },
    });
    expect(controller.sampleNow().phase).toBe("tripped");
    rss = 600;
    const result = await controller.recover();
    expect(result.ok).toBe(true);
    expect(reconnects).toBe(1);
    expect(collections).toBe(1);
    expect(controller.state().phase).toBe("cooling");
    controller.sampleNow();
    expect(controller.state().phase).toBe("cooling");
    controller.sampleNow();
    expect(controller.state().phase).toBe("armed");
    expect(controller.blocked()).toBe(false);
  });

  test("recovery never collects while physical work is still settling", async () => {
    let collections = 0;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(1_000),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: true, message: "rebuilt" }),
      canCollect: () => false,
      gc: () => {
        collections += 1;
      },
    });

    expect(controller.sampleNow().phase).toBe("tripped");
    expect(await controller.recover()).toMatchObject({ ok: true });
    expect(collections).toBe(0);
  });

  test("a non-cooperative run cannot leave the fuse stuck aborting forever", async () => {
    let clock = 0;
    let reconnects = 0;
    let forceStops = 0;
    let active = true;
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(1_000),
      now: () => clock,
      isRunActive: () => active,
      cancelRun: () => true,
      forceStopRun: () => {
        forceStops += 1;
        active = false;
      },
      reconnect: async () => {
        reconnects += 1;
        return { ok: true, message: "rebuilt" };
      },
    });

    expect(controller.sampleNow().phase).toBe("aborting");
    clock = MEMORY_PRESSURE_ABORT_GRACE_MS - 1;
    expect(controller.sampleNow().phase).toBe("aborting");
    clock = MEMORY_PRESSURE_ABORT_GRACE_MS;
    expect(controller.sampleNow().phase).toBe("tripped");
    expect(forceStops).toBe(1);

    const result = await controller.recover();
    expect(result.ok).toBe(true);
    expect(reconnects).toBe(1);
    expect(controller.state().phase).toBe("cooling");
  });

  test("a non-cooperative backend cannot leave recovery stuck or start parallel rebuilds", async () => {
    let rss = 1_000;
    let reconnects = 0;
    let scheduledDelay = 0;
    let fireTimeout: (() => void) | undefined;
    const reconnect = deferred<{ ok: boolean; message: string }>();
    const controller = createMemoryPressureController({
      limitBytes: 1_000,
      sample: () => memory(rss),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: () => {
        reconnects += 1;
        return reconnect.promise;
      },
      setAfter: (callback, delayMs) => {
        fireTimeout = callback;
        scheduledDelay = delayMs;
        return {};
      },
      clearAfter: () => {},
    });

    expect(controller.sampleNow().phase).toBe("tripped");
    const recovering = controller.recover();
    await Promise.resolve();
    expect(controller.state().phase).toBe("recovering");
    expect(reconnects).toBe(1);
    expect(scheduledDelay).toBe(MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS);

    fireTimeout?.();
    expect(await recovering).toEqual({
      ok: false,
      message: `memory recovery timed out after ${String(MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS)}ms; backend shutdown is still pending`,
    });
    expect(controller.state().phase).toBe("tripped");
    expect((await controller.recover()).message).toContain("recovery is still pending");
    expect(reconnects).toBe(1);

    rss = 1;
    reconnect.resolve({ ok: true, message: "rebuilt late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state().phase).toBe("cooling");
  });

  test("the sampler is 500ms, unrefed and stopped explicitly", () => {
    let delay = 0;
    let unrefs = 0;
    let clears = 0;
    const handle = { unref: () => (unrefs += 1) };
    const controller = createMemoryPressureController({
      sample: () => memory(1),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: true, message: "ok" }),
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
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: true, message: "ok" }),
      setEvery: () => {
        timers += 1;
        return {};
      },
    });

    controller.start();
    expect(controller.sampleNow()).toMatchObject({ phase: "disabled", rss: 123 });
    expect(controller.blocked()).toBe(false);
    expect(timers).toBe(0);
    controller.stop();
  });

  test("recovery explains every non-tripped state without reconnecting", async () => {
    let rss = 100;
    let active = true;
    let reconnects = 0;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(rss),
      isRunActive: () => active,
      cancelRun: () => true,
      reconnect: async () => {
        reconnects += 1;
        return { ok: true, message: "ok" };
      },
    });

    expect((await controller.recover()).message).toBe("memory recovery is not required");
    controller.sampleNow();
    expect((await controller.recover()).message).toBe("waiting for the active run to stop");
    active = false;
    controller.sampleNow();
    rss = 1;
    expect((await controller.recover()).ok).toBe(true);
    expect((await controller.recover()).message).toContain("waiting for memory");
    expect(reconnects).toBe(1);
  });

  test("a rejected rebuild returns to tripped so the user can retry", async () => {
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(100),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => ({ ok: false, message: "backend unavailable" }),
    });

    controller.sampleNow();
    expect(await controller.recover()).toEqual({ ok: false, message: "backend unavailable" });
    expect(controller.state().phase).toBe("tripped");
  });

  test("recovery tolerates a throwing GC and reports reconnect errors", async () => {
    let failReconnect = false;
    let rss = 100;
    const controller = createMemoryPressureController({
      limitBytes: 100,
      sample: () => memory(rss),
      isRunActive: () => false,
      cancelRun: () => false,
      reconnect: async () => {
        if (failReconnect) throw "socket closed";
        return { ok: true, message: "rebuilt" };
      },
      gc: () => {
        throw new Error("explicit GC disabled");
      },
    });

    controller.sampleNow();
    await expect(controller.recover()).resolves.toMatchObject({ ok: true });

    // Rearm, trip again, then exercise the reconnect exception path.
    rss = 1;
    controller.sampleNow();
    controller.sampleNow();
    controller.sampleNow();
    failReconnect = true;
    rss = 100;
    controller.sampleNow();
    expect(await controller.recover()).toEqual({
      ok: false,
      message: "memory recovery failed: socket closed",
    });
    expect(controller.state().phase).toBe("tripped");
  });
});
