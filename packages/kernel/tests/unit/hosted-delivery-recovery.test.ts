import { expect, test } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import { kernelError } from "../../src/core/errors.ts";
import {
  recoverHostedDelivery,
  type HostedDeliveryRecovery,
} from "../../src/hosting/delivery-recovery.ts";

test("reconciles a lost receipt acknowledgement with one canonical effect", async () => {
  let writes = 0;
  const canonical = new Set<string>();
  const records: HostedDeliveryRecovery[] = [];
  const complete = await recoverHostedDelivery({
    executionId: "run",
    record: { intent_id: "steer_one", controller_epoch: 2, state: "ready", attempt: 0 },
    logger: NOOP_LOGGER,
    async checkpoint(record) {
      records.push(structuredClone(record));
    },
    async deliver() {
      canonical.add("steer_one");
      if (++writes === 1) throw kernelError("unavailable", "lost acknowledgement");
    },
    async wait() {
      expect(records.at(-1)?.state).toBe("recovering");
    },
  });
  expect(complete).toBe(true);
  expect(writes).toBe(2);
  expect(canonical.size).toBe(1);
});

test("restart preserves the retry allowance and permanent failures wait without retry", async () => {
  for (const code of ["unavailable", "conflict"] as const) {
    let record: HostedDeliveryRecovery = {
      intent_id: "steer_one",
      controller_epoch: 2,
      state: "recovering",
      attempt: 1,
      next_attempt_at: 120,
    };
    let calls = 0;
    const options = {
      executionId: "run",
      logger: NOOP_LOGGER,
      now: () => 120,
      async checkpoint(next: HostedDeliveryRecovery) {
        record = next;
      },
      async deliver() {
        calls++;
        throw kernelError(code, "injected");
      },
      async wait() {},
    };
    expect(await recoverHostedDelivery({ ...options, record })).toBe(false);
    expect(calls).toBe(code === "unavailable" ? 2 : 1);
    expect(record.state).toBe("waiting_external");
    const previous = calls;
    expect(await recoverHostedDelivery({ ...options, record })).toBe(false);
    expect(calls).toBe(previous);
  }
});

test("a failed checkpoint cannot acknowledge or repeat an external operation", async () => {
  let calls = 0;
  await expect(
    recoverHostedDelivery({
      executionId: "run",
      record: { intent_id: "steer_one", controller_epoch: 2, state: "ready", attempt: 0 },
      logger: NOOP_LOGGER,
      async checkpoint() {
        throw kernelError("unavailable", "index unavailable");
      },
      async deliver() {
        calls++;
      },
    }),
  ).rejects.toThrow("index unavailable");
  expect(calls).toBe(0);
});

test("restart at the last uncertain attempt records an external wait without another call", async () => {
  let stored: HostedDeliveryRecovery | undefined;
  let calls = 0;
  expect(
    await recoverHostedDelivery({
      executionId: "run",
      record: { intent_id: "steer_one", controller_epoch: 2, state: "ready", attempt: 3 },
      logger: NOOP_LOGGER,
      async checkpoint(record) {
        stored = record;
      },
      async deliver() {
        calls++;
      },
    }),
  ).toBe(false);
  expect(calls).toBe(0);
  expect(stored).toMatchObject({
    state: "waiting_external",
    cause: "receipt_unconfirmed",
    attempt: 3,
  });
});

test("a future delivery retry neither sleeps nor consumes an attempt before eligibility", async () => {
  let now = 100;
  let calls = 0;
  const record: HostedDeliveryRecovery = {
    intent_id: "steer_future",
    controller_epoch: 2,
    state: "recovering",
    attempt: 1,
    next_attempt_at: 200,
  };
  const checkpoints: HostedDeliveryRecovery[] = [];
  const options = {
    executionId: "run",
    record,
    logger: NOOP_LOGGER,
    now: () => now,
    checkpoint: async (next: HostedDeliveryRecovery) => {
      checkpoints.push(next);
    },
    deliver: async () => {
      calls++;
    },
    wait: async () => {
      throw new Error("future recovery must not sleep inside sync");
    },
  };
  expect(await recoverHostedDelivery(options)).toBe(false);
  expect(calls).toBe(0);
  expect(checkpoints).toEqual([]);
  now = 200;
  expect(await recoverHostedDelivery(options)).toBe(true);
  expect(calls).toBe(1);
  expect(checkpoints[0]).toMatchObject({ attempt: 2, state: "ready" });
});
