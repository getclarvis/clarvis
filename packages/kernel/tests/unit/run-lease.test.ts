import { describe, expect, it } from "bun:test";
import { withRunLease } from "../../src/runs/run-lease.ts";

describe("withRunLease", () => {
  it("admits before execution and releases after success", async () => {
    const calls: string[] = [];

    await expect(
      withRunLease(
        () => {
          calls.push("acquire");
          return () => calls.push("release");
        },
        async () => {
          calls.push("execute");
          return "done";
        },
      ),
    ).resolves.toBe("done");
    expect(calls).toEqual(["acquire", "execute", "release"]);
  });

  it("releases after rejection and never executes after failed admission", async () => {
    const calls: string[] = [];
    await expect(
      withRunLease(
        () => () => calls.push("release"),
        async () => {
          calls.push("execute");
          throw new Error("run failed");
        },
      ),
    ).rejects.toThrow("run failed");
    expect(calls).toEqual(["execute", "release"]);

    await expect(
      withRunLease(
        () => {
          throw new Error("snapshot drift");
        },
        async () => {
          calls.push("should not execute");
          return undefined;
        },
      ),
    ).rejects.toThrow("snapshot drift");
    expect(calls).not.toContain("should not execute");
  });
});
