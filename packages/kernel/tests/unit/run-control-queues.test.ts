import { describe, expect, test } from "bun:test";

import { createCompactionQueue } from "../../src/runs/compaction-queue.ts";
import { createSteerQueue } from "../../src/runs/steer-queue.ts";

describe("run control queues", () => {
  test("steering acknowledges only drained messages and refuses pending work on close", async () => {
    const queue = createSteerQueue();
    const message = { content: "focus here", at: 1 } as never;
    const delivered = queue.push(message);
    expect(queue.undrained()).toEqual([message]);
    expect(queue.drain()).toEqual([message]);
    expect(await delivered).toBe(true);

    const rejected = queue.push(message);
    queue.close();
    expect(await rejected).toBe(false);
    expect(await queue.push(message)).toBe(false);
    expect(queue.undrained()).toEqual([]);
  });

  test("compaction exposes, drains, and rejects requests after close", () => {
    const queue = createCompactionQueue();
    const request = { at: 1 } as never;
    expect(queue.push(request)).toBe(true);
    expect(queue.undrained()).toEqual([request]);
    expect(queue.drain()).toEqual([request]);
    queue.close();
    expect(queue.push(request)).toBe(false);
  });
});
