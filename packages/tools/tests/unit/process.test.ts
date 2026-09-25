import { afterEach, describe, expect, it, vi } from "bun:test";
import { killTree, ownProcessGroup } from "../../src/lib/process.ts";

const DEAD_PID = 2_147_480_000;

describe("process groups", () => {
  afterEach(() => vi.restoreAllMocks());

  it("detaches a child into its own group", () => {
    expect(ownProcessGroup()).toBe(true);
  });

  it("returns false when neither group nor root can be signalled", () => {
    expect(killTree(DEAD_PID, "SIGTERM")).toBe(false);
  });

  it("falls back to the root when the group signal fails", () => {
    const seen: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      seen.push(pid);
      if (pid < 0) throw new Error("no group");
      return true;
    });
    expect(killTree(4321, "SIGTERM")).toBe(true);
    expect(seen).toEqual([-4321, 4321]);
  });

  it("addresses the process group by negative pid", () => {
    const seen: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      seen.push(pid);
      return true;
    });
    expect(killTree(4321, "SIGTERM")).toBe(true);
    expect(seen).toEqual([-4321]);
  });
});
