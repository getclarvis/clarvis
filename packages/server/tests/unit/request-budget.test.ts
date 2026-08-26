import { describe, expect, it } from "bun:test";
import { createRequestBudget } from "../../src/http/request-budget.ts";
import { createManualTimeouts } from "../helpers/manual-timeouts.ts";

describe("session initialization request budget", () => {
  it("keeps one overall deadline across multiple initialization phases", async () => {
    const timeouts = createManualTimeouts();
    const controller = new AbortController();
    const budget = createRequestBudget({
      signal: controller.signal,
      timeoutMs: 25,
      scheduleTimeout: timeouts.schedule,
    });

    expect(await budget.race(Promise.resolve("resolved"))).toEqual({
      state: "fulfilled",
      value: "resolved",
    });
    expect(timeouts.pending).toBe(1);

    const handshake = budget.race(new Promise<void>(() => {}));
    timeouts.fireNext();
    expect(await handshake).toEqual({
      state: "interrupted",
      interruption: {
        code: "unavailable",
        message: "session initialization timed out after 25ms",
        status: 503,
      },
    });
    budget.dispose();
    expect(timeouts.pending).toBe(0);
  });

  it("interrupts immediately when the request aborts and removes its deadline", async () => {
    const timeouts = createManualTimeouts();
    const controller = new AbortController();
    const budget = createRequestBudget({
      signal: controller.signal,
      timeoutMs: 25,
      scheduleTimeout: timeouts.schedule,
    });
    const pending = budget.race(new Promise<void>(() => {}));

    controller.abort();

    expect(await pending).toEqual({
      state: "interrupted",
      interruption: {
        code: "cancelled",
        message: "session initialization request was cancelled",
        status: 408,
      },
    });
    budget.dispose();
    expect(timeouts.pending).toBe(0);
  });

  it("reports work rejection without converting it into a timeout", async () => {
    const timeouts = createManualTimeouts();
    const budget = createRequestBudget({
      signal: new AbortController().signal,
      timeoutMs: 25,
      scheduleTimeout: timeouts.schedule,
    });
    const failure = new Error("resolver failed");

    expect(await budget.race(Promise.reject(failure))).toEqual({
      state: "rejected",
      reason: failure,
    });
    budget.dispose();
    expect(timeouts.pending).toBe(0);
  });
});
