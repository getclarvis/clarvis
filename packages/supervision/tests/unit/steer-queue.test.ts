import { describe, it, expect } from "bun:test";
import { createSteerQueue } from "../../src/steer-queue.ts";

describe("per-child steer queue", () => {
  it("drains what was pushed, in order, exactly once", () => {
    const queue = createSteerQueue();
    expect(queue.push({ content: "first" })).toBe(true);
    expect(queue.push({ content: "second" })).toBe(true);
    expect(queue.drain()).toEqual([{ content: "first" }, { content: "second" }]);
    expect(queue.drain()).toEqual([]);
  });

  it("refuses a push after close rather than throwing — a settled child is a plain refusal", () => {
    const queue = createSteerQueue();
    queue.close();
    expect(queue.push({ content: "too late" })).toBe(false);
    expect(queue.drain()).toEqual([]);
  });

  it("reports what was queued but never drained, so a lost steer is not silent", () => {
    const queue = createSteerQueue();
    queue.push({ content: "never delivered" });
    expect(queue.undrained()).toHaveLength(1);
    queue.drain();
    expect(queue.undrained()).toHaveLength(0);
  });

  it("a close does not discard what is already queued: the child may still drain it", () => {
    const queue = createSteerQueue();
    queue.push({ content: "in flight" });
    queue.close();
    expect(queue.drain()).toEqual([{ content: "in flight" }]);
  });
});
