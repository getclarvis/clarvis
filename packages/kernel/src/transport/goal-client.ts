import { randomUUID } from "node:crypto";
import { detachObserved, type Logger } from "@clarvis/capability";
import type { GoalChange, GoalService, KernelTransport } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import {
  decodeGoalAvailability,
  decodeGoalChange,
  decodeGoalReceipt,
  decodeGoalView,
} from "./goal-codec.ts";
import { createServiceProxy, OPERATIONS } from "./operations.ts";
import { M, N } from "./wire.ts";
import { wireRecord } from "./hosting-codec.ts";

/** Validated goal facade and bounded live subscriptions share the existing authenticated transport. */
export function createGoalClient(options: {
  transport: KernelTransport;
  workspaceId: string;
  logger: Logger;
  protocolViolation(message: string): void;
}): { service: GoalService; close(): void } {
  const { transport } = options;
  const requests = createServiceProxy<Omit<GoalService, "subscribe">>(transport, OPERATIONS.goals);
  const listeners = new Map<string, { sessionId: string; listener(change: GoalChange): void }>();
  let closed = false;
  const checked = <T>(value: T | null): T => {
    if (value !== null) return value;
    options.protocolViolation("Invalid goal response from the kernel");
    throw kernelError("unavailable", "Invalid goal response from the kernel");
  };
  const off = transport.onNotification(N.goalChange, (value) => {
    if (closed) return;
    if (
      !wireRecord(value) ||
      Object.keys(value).some((key) => key !== "subscription_id" && key !== "change") ||
      typeof value.subscription_id !== "string"
    ) {
      options.protocolViolation("Invalid goal change notification");
      return;
    }
    const change = decodeGoalChange(value.change);
    const subscription = listeners.get(value.subscription_id);
    if (
      change === null ||
      (subscription !== undefined && subscription.sessionId !== change.session_id)
    ) {
      options.protocolViolation("Invalid goal change conversation");
      return;
    }
    try {
      subscription?.listener(change);
    } catch {
      options.logger.warn(
        { event: "goal.change.delivery_failed", session_id: change.session_id },
        "Goal change observer failed",
      );
    }
  });
  return {
    service: {
      async availability() {
        return checked(decodeGoalAvailability(await requests.availability()));
      },
      async get(sessionId) {
        return checked(
          decodeGoalView(await requests.get(sessionId), sessionId, options.workspaceId),
        );
      },
      async control(request) {
        return checked(decodeGoalReceipt(await requests.control(request), request.operation_id));
      },
      async receipt(sessionId, operationId) {
        const value = await requests.receipt(sessionId, operationId);
        return value === null ? null : checked(decodeGoalReceipt(value, operationId));
      },
      async subscribe(sessionId, listener) {
        if (closed) throw kernelError("unavailable", "Goal connection is closed");
        if (listeners.size >= 8)
          throw kernelError("resource_exhausted", "Goal subscription limit reached");
        const subscriptionId = randomUUID();
        listeners.set(subscriptionId, { sessionId, listener });
        try {
          const reply = await transport.request(M.goalsSubscribe, {
            session_id: sessionId,
            subscription_id: subscriptionId,
          });
          checked(wireRecord(reply) && Object.keys(reply).length === 0 ? true : null);
          if (closed)
            throw kernelError("unavailable", "Goal connection closed during subscription");
        } catch (error) {
          listeners.delete(subscriptionId);
          throw error;
        }
        return () => {
          if (!listeners.delete(subscriptionId) || closed) return;
          detachObserved(
            () => transport.request(M.goalsUnsubscribe, { subscription_id: subscriptionId }),
            { operation: "goal.unsubscribe", logger: options.logger },
          );
        };
      },
    },
    close() {
      closed = true;
      listeners.clear();
      off();
    },
  };
}
