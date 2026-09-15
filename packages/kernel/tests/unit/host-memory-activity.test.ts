import { expect, test } from "bun:test";
import { kernelError } from "../../src/core/errors.ts";
import { memoryKeepsHostAlive } from "../../src/hosting/memory-activity.ts";
import { memoryError } from "../../src/memory/memory-errors.ts";

test("absent and disabled memory permit idle retirement", async () => {
  expect(await memoryKeepsHostAlive(undefined)).toBe(false);
  expect(
    await memoryKeepsHostAlive({
      jobs: async () => {
        throw memoryError("MEMORY_NOT_CONFIGURED", "disabled");
      },
    }),
  ).toBe(false);
});

test.each(["pending", "running", "retry_wait", "completed", "failed"] as const)(
  "%s memory jobs determine whether physical work still belongs to the host",
  async (state) => {
    const counts = { pending: 0, running: 0, retry_wait: 0, completed: 0, failed: 0 };
    counts[state] = 1;
    expect(await memoryKeepsHostAlive({ jobs: async () => ({ jobs: [], counts }) })).toBe(
      state !== "completed" && state !== "failed",
    );
  },
);

test("an empty memory queue permits idle retirement", async () => {
  expect(
    await memoryKeepsHostAlive({
      jobs: async () => ({
        jobs: [],
        counts: { pending: 0, running: 0, retry_wait: 0, completed: 0, failed: 0 },
      }),
    }),
  ).toBe(false);
});

test.each([
  memoryError("MEMORY_RECOVERY_REQUIRED", "recover storage"),
  kernelError("capability_disabled", "a different capability is disabled"),
  new Error("storage read failed"),
])("a queue failure never authorizes idle retirement: %s", async (failure) => {
  await expect(
    memoryKeepsHostAlive({
      jobs: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});
