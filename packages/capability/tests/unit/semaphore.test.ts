import { describe, it, expect } from "../helpers/bun-test.ts";
import { createSemaphore } from "../../src/semaphore.ts";

describe("createSemaphore", () => {
  it("allows up to `limit` concurrent acquisitions, queueing the rest", async () => {
    const s = createSemaphore(2);
    await s.acquire();
    await s.acquire();
    let third = false;
    const p = s.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
    s.release();
    await p;
    expect(third).toBe(true);
  });

  it("releases waiters in FIFO order", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const order: number[] = [];
    const p1 = s.acquire().then(() => order.push(1));
    const p2 = s.acquire().then(() => order.push(2));
    s.release();
    await p1;
    s.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("coerces a limit below one, and a fractional limit, to a whole slot count", async () => {
    const zero = createSemaphore(0);
    await zero.acquire();
    let second = false;
    void zero.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBe(false);

    const fractional = createSemaphore(2.9);
    await fractional.acquire();
    await fractional.acquire();
    let third = false;
    void fractional.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
  });

  it("clamps a release with no waiter and no holder at zero rather than banking a slot", async () => {
    const s = createSemaphore(1);
    s.release();
    s.release();
    await s.acquire();
    let second = false;
    void s.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBe(false);
  });

  it("a slot freed in finally (release-on-throw) lets the next waiter proceed", async () => {
    const s = createSemaphore(1);
    const ran: string[] = [];
    async function task(name: string, shouldThrow: boolean): Promise<void> {
      await s.acquire();
      try {
        ran.push(name);
        if (shouldThrow) throw new Error("boom");
      } finally {
        s.release();
      }
    }
    const a = task("a", true).catch(() => {});
    const b = task("b", false);
    await Promise.allSettled([a, b]);
    expect(ran).toEqual(["a", "b"]);
  });

  it("a queued acquire rejects and stops waiting once its signal aborts, instead of hanging forever", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const controller = new AbortController();
    const p = s.acquire(controller.signal);
    let settled = false;
    void p
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });

  it("rejects with a generic Error when the abort reason is not one", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const controller = new AbortController();
    const p = s.acquire(controller.signal);
    controller.abort("just a string");
    await expect(p).rejects.toThrow("aborted");
  });

  it("an abandoned (aborted) waiter does not leak a slot to a later release", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const controller = new AbortController();
    const abandoned = s.acquire(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(abandoned).rejects.toThrow();

    let granted = false;
    const next = s.acquire().then(() => {
      granted = true;
    });
    s.release();
    await next;
    expect(granted).toBe(true);
  });

  it("an already-aborted signal rejects immediately without ever queueing", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(s.acquire(controller.signal)).rejects.toThrow("already gone");
  });

  it("an immediate grant (under the limit) resolves even with an already-aborted signal", async () => {
    const s = createSemaphore(2);
    await s.acquire();
    const controller = new AbortController();
    controller.abort(new Error("irrelevant"));
    await expect(s.acquire(controller.signal)).resolves.toBeUndefined();
  });

  it("stops listening on the signal once the slot is granted", async () => {
    const s = createSemaphore(1);
    await s.acquire();
    const controller = new AbortController();
    const queued = s.acquire(controller.signal);
    s.release();
    await queued;
    controller.abort(new Error("too late"));
    expect(controller.signal.aborted).toBe(true);
  });
});
