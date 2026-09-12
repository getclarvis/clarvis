import type {
  ToolInterruptDelivery,
  ToolInterruptSettleStatus,
  ToolInterruptSource,
} from "@clarvis/loop";
import type { ToolInterruptReceipt } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

/** Alphabet of a well-formed live tool-execution token. */
export const TOOL_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/** Small bound on interrupt requests awaiting settlement on one run. */
const MAX_TOOL_INTERRUPT_PENDING = 16;

interface PendingInterrupt {
  readonly toolExecutionId: string;
  readonly waiters: Array<(status: ToolInterruptSettleStatus) => void>;
  settled: boolean;
}

/** Run-scoped interrupt channel: validates tokens, coalesces repeats, and settles on close. */
export interface ToolInterruptChannel extends ToolInterruptSource {
  interruptTool(toolExecutionId: string): Promise<ToolInterruptReceipt>;
  close(): void;
}

function invalidToolExecutionId(): never {
  throw kernelError("invalid_request", "tool_execution_id is not a valid identifier");
}

function receipt(toolExecutionId: string, status: ToolInterruptSettleStatus): ToolInterruptReceipt {
  return { tool_execution_id: toolExecutionId, status };
}

/** Create a bounded interrupt channel owned by one managed run. */
export function createToolInterruptChannel(): ToolInterruptChannel {
  const listeners = new Set<(delivery: ToolInterruptDelivery) => void>();
  const pending = new Map<string, PendingInterrupt>();
  const queued: ToolInterruptDelivery[] = [];
  let closed = false;

  const finish = (entry: PendingInterrupt, status: ToolInterruptSettleStatus): void => {
    if (entry.settled) return;
    entry.settled = true;
    pending.delete(entry.toolExecutionId);
    const [first, ...rest] = entry.waiters;
    first?.(status);
    const extra = status === "accepted" ? "already_requested" : status;
    for (const waiter of rest) waiter(extra);
  };

  const enqueue = (toolExecutionId: string): void => {
    const delivery: ToolInterruptDelivery = {
      toolExecutionId,
      settle(status) {
        const entry = pending.get(toolExecutionId);
        if (entry === undefined) return;
        finish(entry, status);
      },
    };
    if (listeners.size === 0) {
      queued.push(delivery);
      return;
    }
    for (const listener of listeners) listener(delivery);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      const waiting = queued.splice(0);
      for (const delivery of waiting) listener(delivery);
      return () => {
        listeners.delete(listener);
      };
    },
    interruptTool(toolExecutionId) {
      if (typeof toolExecutionId !== "string" || !TOOL_EXECUTION_ID.test(toolExecutionId)) {
        invalidToolExecutionId();
      }
      if (closed) return Promise.resolve(receipt(toolExecutionId, "not_running"));
      const existing = pending.get(toolExecutionId);
      if (existing !== undefined) {
        return new Promise<ToolInterruptReceipt>((resolve) => {
          existing.waiters.push((status) => resolve(receipt(toolExecutionId, status)));
        });
      }
      if (pending.size >= MAX_TOOL_INTERRUPT_PENDING) {
        throw kernelError("resource_exhausted", "too many pending tool interrupt requests");
      }
      return new Promise<ToolInterruptReceipt>((resolve) => {
        pending.set(toolExecutionId, {
          toolExecutionId,
          waiters: [(status) => resolve(receipt(toolExecutionId, status))],
          settled: false,
        });
        enqueue(toolExecutionId);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      for (const entry of [...pending.values()]) finish(entry, "not_running");
      listeners.clear();
    },
  };
}
