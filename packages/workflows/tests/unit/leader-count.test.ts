import { describe, expect, test } from "bun:test";
import { createWorkflowLeaderCount } from "../../src/leader-count.ts";

describe("WorkflowLeaderCount", () => {
  test("rejects an invalid lifetime ceiling", () => {
    expect(() => createWorkflowLeaderCount(0)).toThrow(
      "workflow leader limit must be a positive integer",
    );
  });

  test("reserves a whole group atomically and counts only registered leaders", () => {
    const count = createWorkflowLeaderCount(3);
    const group = count.reserve(2);
    expect(group).not.toBeNull();
    expect(group!.remaining()).toBe(2);
    expect(count.started()).toBe(0);
    expect(count.remaining()).toBe(1);
    expect(count.reserve(2)).toBeNull();

    expect(group!.consume()).toBe(true);
    expect(group!.remaining()).toBe(1);
    expect(count.started()).toBe(1);
    group!.release();
    expect(count.remaining()).toBe(2);
  });

  test("cannot exceed its lifetime ceiling across separate tool admissions", () => {
    const count = createWorkflowLeaderCount(2);
    for (let index = 0; index < 2; index += 1) {
      const one = count.reserve(1);
      expect(one?.consume()).toBe(true);
      one?.release();
    }
    expect(count.started()).toBe(2);
    expect(count.remaining()).toBe(0);
    expect(count.reserve(1)).toBeNull();
  });
});
