import type { SteerMessage, SteerSource } from "@clarvis/loop";

/**
 * In-memory {@link SteerSource} that buffers mid-run user steering messages.
 */
export interface SteerQueue extends SteerSource {
  /**
   * Enqueues a steering message and settles only when the loop drains it.
   *
   * @returns `false` when the run closes before delivery or was already closed.
   */
  push(message: SteerMessage): Promise<boolean>;
  /** Rejects further pushes and refuses every message still awaiting a drain. */
  close(): void;
  /** Returns messages still waiting to be drained (does not clear). */
  undrained(): SteerMessage[];
}

/** Creates an empty {@link SteerQueue}. */
export function createSteerQueue(): SteerQueue {
  let queue: { message: SteerMessage; settle: (delivered: boolean) => void }[] = [];
  let closed = false;
  return {
    push(message: SteerMessage): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((settle) => queue.push({ message, settle }));
    },
    drain(): SteerMessage[] {
      const out = queue;
      queue = [];
      for (const entry of out) entry.settle(true);
      return out.map((entry) => entry.message);
    },
    close(): void {
      if (closed) return;
      closed = true;
      const pending = queue;
      queue = [];
      for (const entry of pending) entry.settle(false);
    },
    undrained(): SteerMessage[] {
      return queue.map((entry) => entry.message);
    },
  };
}
