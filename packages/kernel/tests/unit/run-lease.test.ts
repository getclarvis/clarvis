import { describe, expect, it } from "bun:test";
import type { RunHandle } from "@clarvis/protocol";
import { releaseRunLeases, withRunLease } from "../../src/runs/run-lease.ts";

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

it("releases the skill catalog at physical completion before memory stream closure", async () => {
  const done = Promise.withResolvers<Awaited<RunHandle["done"]>>();
  const closed = Promise.withResolvers<void>();
  const released: string[] = [];
  releaseRunLeases(
    { done: done.promise, closed: closed.promise },
    {
      skillCatalog: () => released.push("catalog"),
      host: () => released.push("host"),
    },
  );

  done.resolve({ execution_id: "run", status: "completed" });
  await done.promise;
  await Promise.resolve();
  expect(released).toEqual(["catalog"]);

  closed.resolve();
  await closed.promise;
  await Promise.resolve();
  expect(released).toEqual(["catalog", "host"]);
});
