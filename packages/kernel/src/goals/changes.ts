import type { Logger } from "@clarvis/capability";
import type { GoalChange } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

/** Small invalidations follow durable state or physical lifecycle changes; they contain no authority. */
export function createGoalChanges(logger: Logger) {
  const listeners = new Map<object, { sessionId: string; listener(change: GoalChange): void }>();
  let closed = false;
  return {
    subscribe(sessionId: string, listener: (change: GoalChange) => void): () => void {
      if (closed) throw kernelError("unavailable", "Goal subscriptions are closed");
      if (listeners.size >= 128)
        throw kernelError("resource_exhausted", "Goal subscription limit reached");
      const key = {};
      listeners.set(key, { sessionId, listener });
      return () => {
        listeners.delete(key);
      };
    },
    notify(sessionId: string): void {
      for (const subscriber of listeners.values()) {
        if (subscriber.sessionId !== sessionId) continue;
        try {
          subscriber.listener({ session_id: sessionId });
        } catch {
          logger.warn(
            { event: "goal.change.delivery_failed", session_id: sessionId },
            "Goal change observer failed",
          );
        }
      }
    },
    close(): void {
      closed = true;
      listeners.clear();
    },
  };
}
