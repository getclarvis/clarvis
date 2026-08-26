import { describe, it, expect, beforeEach, afterEach, vi } from "../helpers/bun-test.ts";
import { createComputeClock } from "../../src/compute-clock.ts";
import type { Logger, LogFn } from "../../src/ports.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const loopAfter = <T>(ms: number, value: T): Promise<T> => sleep(ms).then(() => value);

async function settle<T>(race: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return race;
}

function captureLogger(): { logger: Logger; debug: { obj: unknown; msg?: string }[] } {
  const debug: { obj: unknown; msg?: string }[] = [];
  const ignore: LogFn = () => {};
  const logger: Logger = {
    debug: (...args: unknown[]) => {
      const [obj, msg] = args;
      debug.push({ obj, ...(typeof msg === "string" ? { msg } : {}) });
    },
    info: ignore,
    warn: ignore,
    error: ignore,
  };
  return { logger, debug };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compute-clock", () => {
  it("zero pause: fires at ~timeoutMs — identical to a plain setTimeout race", async () => {
    const clock = createComputeClock(50);
    expect(await settle(clock.race(loopAfter(500, "loop")))).toBe("timeout");
  });

  it("loop wins when it finishes before the deadline", async () => {
    const clock = createComputeClock(500);
    expect(await settle(clock.race(loopAfter(20, "loop")))).toBe("loop");
  });

  it("pause excludes elapsed time: a long human-wait while paused does not trip the deadline", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.pause();
      await sleep(300);
      clock.resume();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("resume re-arms the remaining budget: the deadline still fires after resume", async () => {
    const clock = createComputeClock(80);
    const loop = (async () => {
      await sleep(55);
      clock.pause();
      await sleep(150);
      clock.resume();
      await sleep(400);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("timeout");
  });

  it("pause does NOT suspend the deadline while a compute activity is in flight (enter gauge)", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.enter();
      clock.pause();
      await sleep(300);
      clock.resume();
      clock.leave();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("timeout");
  });

  it("the deadline suspends again once the last compute activity leaves while paused", async () => {
    const clock = createComputeClock(200);
    const loop = (async () => {
      await sleep(30);
      clock.enter();
      clock.pause();
      await sleep(80);
      clock.leave();
      await sleep(300);
      clock.resume();
      await sleep(40);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("leave() below zero is a no-op (does not falsely un-pause a genuine human-only wait)", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.leave();
      clock.pause();
      await sleep(300);
      clock.resume();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("a lone Subagent's own elicitation suspends the deadline (compute-aware pause)", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.enter();
      const release = clock.pauseCompute();
      await sleep(300);
      release();
      clock.leave();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("pauseCompute keeps ticking while a sibling compute is still in flight", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(20);
      clock.enter();
      clock.enter();
      const release = clock.pauseCompute();
      await sleep(300);
      release();
      clock.leave();
      clock.leave();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("timeout");
  });

  it("suspends once every in-flight compute is itself paused", async () => {
    const clock = createComputeClock(200);
    const loop = (async () => {
      await sleep(20);
      clock.enter();
      clock.enter();
      const r1 = clock.pauseCompute();
      const r2 = clock.pauseCompute();
      await sleep(400);
      r1();
      r2();
      clock.leave();
      clock.leave();
      await sleep(40);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("pauseCompute with no compute in flight suspends and does not leak the gauge", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      const release = clock.pauseCompute();
      await sleep(300);
      release();
      clock.pause();
      await sleep(300);
      clock.resume();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("pauseCompute release is idempotent", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.enter();
      const release = clock.pauseCompute();
      await sleep(200);
      release();
      release();
      clock.leave();
      clock.pause();
      await sleep(300);
      clock.resume();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("poke refills the budget: a loop that pokes faster than the window never trips (stall watchdog)", async () => {
    const clock = createComputeClock(50);
    const loop = (async () => {
      for (let i = 0; i < 6; i += 1) {
        await sleep(30);
        clock.poke();
      }
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("poke after the deadline already fired is a no-op (does not revive a dead run)", async () => {
    const clock = createComputeClock(20);
    await vi.advanceTimersByTimeAsync(45);
    clock.poke();
    expect(await settle(clock.race(loopAfter(300, "loop")))).toBe("timeout");
  });

  it("poke while paused refills the budget; the full window applies after resume", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      await sleep(40);
      clock.pause();
      clock.poke();
      await sleep(300);
      clock.resume();
      await sleep(40);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("nested pause/resume is depth-safe", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      await sleep(30);
      clock.pause();
      clock.pause();
      await sleep(200);
      clock.resume();
      await sleep(200);
      clock.resume();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });
});

describe("compute-clock — deadline already fired before race", () => {
  it("resolves to timeout immediately when the timer fired before race() was called", async () => {
    const clock = createComputeClock(10);
    await vi.advanceTimersByTimeAsync(40);
    expect(await settle(clock.race(loopAfter(300, "loop")))).toBe("timeout");
  });
});

describe("compute-clock — pause/resume guards", () => {
  it("resume() before any pause is a no-op and the deadline still fires", async () => {
    const clock = createComputeClock(40);
    clock.resume();
    expect(await settle(clock.race(loopAfter(400, "loop")))).toBe("timeout");
  });

  it("pausing after the deadline already fired does not reopen the budget", async () => {
    const clock = createComputeClock(15);
    await vi.advanceTimersByTimeAsync(45);
    clock.pause();
    clock.resume();
    expect(await settle(clock.race(loopAfter(300, "loop")))).toBe("timeout");
  });
});

describe("compute-clock — single-shot guard", () => {
  it("rejects a second race() call", async () => {
    const clock = createComputeClock(1000);
    expect(await settle(clock.race(loopAfter(5, "first")))).toBe("first");
    await expect(clock.race(Promise.resolve("second"))).rejects.toThrow(
      "ComputeClock.race() is single-shot and was already consumed.",
    );
  });
});

describe("compute-clock — loop rejects after the race settled", () => {
  it("swallows an Error rejection and logs its message", async () => {
    const { logger, debug } = captureLogger();
    const clock = createComputeClock(20, logger);
    const loop = sleep(200).then((): string => {
      throw new Error("late boom");
    });
    expect(await settle(clock.race(loop))).toBe("timeout");
    await vi.runAllTimersAsync();
    expect(debug).toHaveLength(1);
    expect(debug[0]!.obj).toMatchObject({
      event: "capability.compute_clock.loop_rejected",
      err: "late boom",
    });
  });

  it("stringifies a non-Error rejection", async () => {
    const { logger, debug } = captureLogger();
    const clock = createComputeClock(20, logger);
    const loop = sleep(200).then((): string => {
      throw "string boom";
    });
    expect(await settle(clock.race(loop))).toBe("timeout");
    await vi.runAllTimersAsync();
    expect(debug).toHaveLength(1);
    expect((debug[0]!.obj as { err: string }).err).toBe("string boom");
  });

  it("does not throw when no logger is provided and the loop rejects late", async () => {
    const clock = createComputeClock(20);
    const loop = sleep(200).then((): string => {
      throw new Error("unobserved");
    });
    expect(await settle(clock.race(loop))).toBe("timeout");
    await expect(vi.runAllTimersAsync()).resolves.toBeDefined();
  });
});

describe("compute-clock — background regions", () => {
  it("a parent's pauseCompute cannot claim a background child's work: the clock stays armed", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      const region = clock.enterBackground();
      const release = clock.pauseCompute();
      await sleep(400);
      release();
      region.leave();
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("timeout");
  });

  it("a background child that pauses its own region lets the clock stop", async () => {
    const clock = createComputeClock(120);
    const loop = (async () => {
      const region = clock.enterBackground();
      const release = clock.pauseCompute();
      const inner = region.pause();
      await sleep(400);
      inner();
      release();
      region.leave();
      await sleep(30);
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("an unpaused background region keeps the clock armed while the parent waits", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      const region = clock.enterBackground();
      clock.pause();
      await sleep(400);
      clock.resume();
      region.leave();
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("timeout");
  });

  it("leaving a paused region drops its pause, so it cannot hold the clock stopped", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      const region = clock.enterBackground();
      region.pause();
      clock.pause();
      await sleep(20);
      region.leave();
      await sleep(400);
      clock.resume();
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("region pause/leave are idempotent per call and never unbalance the counters", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      const region = clock.enterBackground();
      const release = region.pause();
      release();
      release();
      region.leave();
      region.leave();
      const lateRelease = region.pause();
      lateRelease();
      lateRelease();
      clock.pause();
      await sleep(400);
      clock.resume();
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });

  it("with no background region the pause behaviour is unchanged", async () => {
    const clock = createComputeClock(60);
    const loop = (async () => {
      const release = clock.pauseCompute();
      await sleep(400);
      release();
      return "loop" as const;
    })();
    expect(await settle(clock.race(loop))).toBe("loop");
  });
});
