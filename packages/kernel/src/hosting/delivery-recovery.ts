import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@clarvis/capability";
import { isRecoverableSettlementFailure } from "./settlement-recovery.ts";

/** A synced steering event proves consumption; only its canonical receipt remains pending. */
export interface HostedDeliveryRecovery {
  intent_id: string;
  controller_epoch: number;
  state: "ready" | "recovering" | "waiting_external";
  attempt: number;
  cause?: "storage_unavailable" | "operation_failed" | "receipt_unconfirmed";
  next_attempt_at?: number;
}

/** Reconcile one idempotent receipt without replaying steering or granting execution authority. */
export async function recoverHostedDelivery(options: {
  executionId: string;
  record: HostedDeliveryRecovery;
  checkpoint(record: HostedDeliveryRecovery): Promise<void>;
  deliver(): Promise<void>;
  logger: Logger;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  let record = options.record;
  if (record.state === "waiting_external") return false;
  if (record.next_attempt_at !== undefined && record.next_attempt_at > now()) return false;
  while (record.attempt < 3) {
    record = {
      intent_id: record.intent_id,
      controller_epoch: record.controller_epoch,
      state: "ready",
      attempt: record.attempt + 1,
    };
    await options.checkpoint(record);
    try {
      await options.deliver();
      return true;
    } catch (error) {
      const transient = isRecoverableSettlementFailure(error);
      const retry = transient && record.attempt < 3;
      const pause = Math.round(100 * 2 ** (record.attempt - 1) * (0.75 + Math.random() * 0.5));
      record = {
        ...record,
        state: retry ? "recovering" : "waiting_external",
        cause: transient ? "storage_unavailable" : "operation_failed",
        ...(retry ? { next_attempt_at: now() + pause } : {}),
      };
      await options.checkpoint(record);
      options.logger.warn(
        {
          event: "hosting.delivery.recovery",
          execution_id: options.executionId,
          intent_id: record.intent_id,
          operation: "reconcile_receipt",
          attempt: record.attempt,
          state: record.state,
          cause: record.cause,
        },
        "operator consumption receipt requires reconciliation",
      );
      if (!retry) return false;
      await wait(pause);
    }
  }
  await options.checkpoint({ ...record, state: "waiting_external", cause: "receipt_unconfirmed" });
  return false;
}
