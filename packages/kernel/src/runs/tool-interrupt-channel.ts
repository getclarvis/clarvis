import { sanitizeErrorMessage } from "@clarvis/capability";
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

/** Absolute delivery deadline, independent of repeated requests for the same token. */
export const TOOL_INTERRUPT_TIMEOUT_MS = 30_000;

interface PendingInterrupt {
  readonly delivery: ToolInterruptDelivery;
  readonly repeated: Promise<ToolInterruptReceipt>;
}

/** Run-scoped interrupt channel: validates tokens, coalesces repeats, and settles on close. */
export interface ToolInterruptChannel extends ToolInterruptSource {
  interruptTool(toolExecutionId: string): Promise<ToolInterruptReceipt>;
  close(): void;
}

function receipt(toolExecutionId: string, status: ToolInterruptSettleStatus): ToolInterruptReceipt {
  return Object.freeze({ tool_execution_id: toolExecutionId, status });
}

/** Create a bounded interrupt channel; an internal test override may shorten its deadline. */
export function createToolInterruptChannel(
  timeoutMs = TOOL_INTERRUPT_TIMEOUT_MS,
): ToolInterruptChannel {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TOOL_INTERRUPT_TIMEOUT_MS) {
    throw kernelError("invalid_request", "invalid tool interrupt timeout");
  }
  const listeners = new Set<(delivery: ToolInterruptDelivery) => void>();
  const pending = new Map<string, PendingInterrupt>();
  const queued = new Set<ToolInterruptDelivery>();
  let closed = false;

  const dispatch = (
    listener: (delivery: ToolInterruptDelivery) => void,
    delivery: ToolInterruptDelivery,
  ): void => {
    try {
      listener(delivery);
    } catch (error) {
      delivery.fail(error);
    }
  };

  return {
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      for (const delivery of queued) {
        queued.delete(delivery);
        dispatch(listener, delivery);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    interruptTool(toolExecutionId) {
      if (typeof toolExecutionId !== "string" || !TOOL_EXECUTION_ID.test(toolExecutionId)) {
        throw kernelError("invalid_request", "tool_execution_id is not a valid identifier");
      }
      if (closed) return Promise.resolve(receipt(toolExecutionId, "not_running"));
      const existing = pending.get(toolExecutionId);
      if (existing !== undefined) return existing.repeated;
      if (pending.size >= MAX_TOOL_INTERRUPT_PENDING) {
        throw kernelError("resource_exhausted", "too many pending tool interrupt requests");
      }
      const first = Promise.withResolvers<ToolInterruptReceipt>();
      const repeated = Promise.withResolvers<ToolInterruptReceipt>();
      void first.promise.catch(() => undefined);
      void repeated.promise.catch(() => undefined);
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        pending.delete(toolExecutionId);
        queued.delete(delivery);
        return true;
      };
      const delivery: ToolInterruptDelivery = {
        toolExecutionId,
        settle(status) {
          if (!cleanup()) return;
          first.resolve(receipt(toolExecutionId, status));
          repeated.resolve(
            receipt(toolExecutionId, status === "accepted" ? "already_requested" : status),
          );
        },
        fail(error) {
          if (!cleanup()) return;
          const failure = kernelError(
            "unavailable",
            error instanceof Error
              ? sanitizeErrorMessage(error.message).slice(0, 1024)
              : "tool interrupt delivery failed",
          );
          first.reject(failure);
          repeated.reject(failure);
        },
      };
      const timer = setTimeout(() => {
        if (queued.has(delivery)) delivery.settle("not_running");
        else delivery.fail(new Error("tool interrupt delivery timed out"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(toolExecutionId, { delivery, repeated: repeated.promise });
      if (listeners.size === 0) queued.add(delivery);
      else for (const listener of listeners) dispatch(listener, delivery);
      return first.promise;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) entry.delivery.settle("not_running");
      listeners.clear();
    },
  };
}
