import { setTimeout as delay } from "node:timers/promises";
import { PersistenceError, type Logger } from "@clarvis/capability";
import { KernelException } from "../core/errors.ts";

/** Durable host checkpoint; terminal commit is eligible only after physical closure and reconciliation. */
export interface HostedSettlementRecovery {
  operation: "reconcile" | "commit_terminal";
  state: "ready" | "recovering" | "waiting_external";
  attempt: number;
  physical_closed: true;
  controller_epoch: number;
  cause?: "storage_unavailable" | "operation_failed";
  next_attempt_at?: number;
}

/** Only known transient infrastructure failures may repeat an idempotent host transaction. */
export function isRecoverableSettlementFailure(error: unknown): boolean {
  if (error instanceof PersistenceError) return true;
  if (error instanceof KernelException) return error.code === "unavailable";
  return (
    error instanceof Error &&
    "code" in error &&
    ["EIO", "EINTR", "EBUSY", "EAGAIN", "ETIMEDOUT"].includes(String(error.code))
  );
}

/** Retry only the host's idempotent recovery-index checkpoint, never the operation it describes. */
export async function persistHostedRecoveryCheckpoint(options: {
  executionId: string;
  operation: "reconcile" | "commit_terminal" | "reconcile_receipt";
  persist(): Promise<void>;
  logger: Logger;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await options.persist();
      return;
    } catch (error) {
      if (!isRecoverableSettlementFailure(error) || attempt >= 3) throw error;
      options.logger.warn(
        {
          event: "hosting.recovery.checkpoint_retry",
          execution_id: options.executionId,
          operation: options.operation,
          attempt,
        },
        "hosted recovery checkpoint is unavailable",
      );
      await (options.wait ?? delay)(
        Math.round(100 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)),
      );
    }
  }
}

/**
 * Run one physically closed settlement through two independently checkpointed idempotent phases.
 * Never retries model/tool calls. Exhaustion retains the exact pending phase for host recovery.
 */
export async function recoverHostedSettlement(options: {
  executionId: string;
  controllerEpoch: number;
  reconciled?: boolean;
  reconcile(): Promise<void>;
  commitTerminal(): Promise<void>;
  checkpoint(record: HostedSettlementRecovery): Promise<void>;
  logger: Logger;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const checkpoint = (record: HostedSettlementRecovery): Promise<void> =>
    persistHostedRecoveryCheckpoint({
      executionId: options.executionId,
      operation: record.operation,
      persist: () => options.checkpoint(record),
      logger: options.logger,
      wait,
    });
  for (const operation of ["reconcile", "commit_terminal"] as const) {
    if (operation === "reconcile" && options.reconciled === true) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const record: HostedSettlementRecovery = {
        operation,
        state: "ready",
        attempt,
        physical_closed: true,
        controller_epoch: options.controllerEpoch,
      };
      await checkpoint(record);
      try {
        await options[operation === "reconcile" ? "reconcile" : "commitTerminal"]();
        break;
      } catch (error) {
        const canRetry = isRecoverableSettlementFailure(error) && attempt < 3;
        const pause = Math.round(100 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
        await checkpoint({
          ...record,
          state: canRetry ? "recovering" : "waiting_external",
          cause: isRecoverableSettlementFailure(error) ? "storage_unavailable" : "operation_failed",
          ...(canRetry ? { next_attempt_at: now() + pause } : {}),
        });
        options.logger.warn(
          {
            event: "hosting.settlement.recovery",
            execution_id: options.executionId,
            operation,
            attempt,
            state: canRetry ? "recovering" : "waiting_external",
          },
          "hosted settlement requires recovery",
        );
        if (!canRetry) throw error;
        await wait(pause);
      }
    }
  }
}
