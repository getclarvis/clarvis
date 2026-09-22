import { expect, test } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import { kernelError } from "../../src/core/errors.ts";
import {
  recoverHostedSettlement,
  type HostedSettlementRecovery,
} from "../../src/hosting/settlement-recovery.ts";

test("retries a lost checkpoint acknowledgement before allowing the next phase", async () => {
  let reconciles = 0;
  let terminals = 0;
  let failed = false;
  let stored: HostedSettlementRecovery | undefined;
  await recoverHostedSettlement({
    executionId: "execution",
    controllerEpoch: 4,
    logger: NOOP_LOGGER,
    async checkpoint(record) {
      stored = structuredClone(record);
      if (record.operation === "commit_terminal" && !failed) {
        failed = true;
        throw kernelError("unavailable", "acknowledgement lost after checkpoint write");
      }
    },
    async reconcile() {
      reconciles++;
    },
    async commitTerminal() {
      terminals++;
    },
    async wait() {
      expect(terminals).toBe(0);
    },
  });
  expect(reconciles).toBe(1);
  expect(terminals).toBe(1);
  expect(stored).toMatchObject({ operation: "commit_terminal", physical_closed: true });
});

test("retries only the pending idempotent phase and persists each retry before waiting", async () => {
  const records: HostedSettlementRecovery[] = [];
  let reconciles = 0;
  let terminals = 0;
  await recoverHostedSettlement({
    executionId: "execution",
    controllerEpoch: 4,
    logger: NOOP_LOGGER,
    now: () => 100,
    async checkpoint(record) {
      records.push(record);
    },
    async reconcile() {
      reconciles++;
    },
    async commitTerminal() {
      terminals++;
      if (terminals === 1) throw kernelError("unavailable", "temporary storage failure");
    },
    async wait(ms) {
      expect(records.at(-1)).toMatchObject({
        operation: "commit_terminal",
        state: "recovering",
        next_attempt_at: 100 + ms,
      });
    },
  });
  expect(reconciles).toBe(1);
  expect(terminals).toBe(2);
  expect(records.at(-1)).toMatchObject({
    operation: "commit_terminal",
    attempt: 2,
    physical_closed: true,
  });
});

test("exhaustion and permanent failures retain the pending phase without fabricating closure", async () => {
  for (const code of ["unavailable", "conflict"] as const) {
    const records: HostedSettlementRecovery[] = [];
    let attempts = 0;
    let terminals = 0;
    await expect(
      recoverHostedSettlement({
        executionId: "execution",
        controllerEpoch: 4,
        logger: NOOP_LOGGER,
        async checkpoint(record) {
          records.push(record);
        },
        async reconcile() {
          attempts++;
          throw kernelError(code, "injected");
        },
        async commitTerminal() {
          terminals++;
        },
        async wait() {},
      }),
    ).rejects.toMatchObject({ code });
    expect(attempts).toBe(code === "unavailable" ? 3 : 1);
    expect(terminals).toBe(0);
    expect(records.at(-1)).toMatchObject({ operation: "reconcile", state: "waiting_external" });
  }
});
