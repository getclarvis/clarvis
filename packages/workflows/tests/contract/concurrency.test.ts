import { describe, expect, test } from "bun:test";
import { createSemaphore } from "@clarvis/capability";

import { createWorkflowSemaphore } from "../../src/concurrency.ts";

describe("createWorkflowSemaphore", () => {
  test("is @clarvis/capability's semaphore under the workflow-facing name", () => {
    expect(createWorkflowSemaphore).toBe(createSemaphore);
  });

  test("bounds leader fan-out and hands a released slot to the longest waiter", async () => {
    const semaphore = createWorkflowSemaphore(1);
    await semaphore.acquire();
    const order: number[] = [];
    const first = semaphore.acquire().then(() => order.push(1));
    const second = semaphore.acquire().then(() => order.push(2));
    await Promise.resolve();
    expect(order).toEqual([]);
    semaphore.release();
    await first;
    semaphore.release();
    await second;
    expect(order).toEqual([1, 2]);
  });

  test("a queued leader that is cancelled rejects instead of waiting forever", async () => {
    const semaphore = createWorkflowSemaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort(new Error("workflow cancelled"));
    await expect(queued).rejects.toThrow("workflow cancelled");
  });
});
