import type { SteerMessage, SteerSource } from "@clarvis/loop";

/**
 * In-memory {@link SteerSource} that buffers mid-run user steering messages.
 */
export interface SteerQueue extends SteerSource {
  /** Enqueues a steering message while the queue is open. */
  push(message: SteerMessage): void;
  /** Rejects further pushes; remaining messages stay until drained. */
  close(): void;
  /** Returns messages still waiting to be drained (does not clear). */
  undrained(): SteerMessage[];
}

/** Creates an empty {@link SteerQueue}. */
export function createSteerQueue(): SteerQueue {
  let queue: SteerMessage[] = [];
  let closed = false;
  return {
    push(message: SteerMessage): void {
      if (!closed) queue.push(message);
    },
    drain(): SteerMessage[] {
      const out = queue;
      queue = [];
      return out;
    },
    close(): void {
      closed = true;
    },
    undrained(): SteerMessage[] {
      return queue;
    },
  };
}
