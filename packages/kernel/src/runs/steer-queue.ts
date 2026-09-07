import type { SteerMessage, SteerSource } from "@clarvis/loop";

/** One transferred message whose acknowledgement still belongs to its final consumer. */
export interface SteerDelivery {
  readonly message: SteerMessage;
  settle(delivered: boolean): void;
}

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
  /** Transfers pending messages without acknowledging delivery to another execution boundary. */
  take(): SteerDelivery[];
  /** Rejects further pushes and refuses every message still awaiting a drain. */
  close(): void;
  /** Returns messages still waiting to be drained (does not clear). */
  undrained(): SteerMessage[];
}

/** Creates an empty {@link SteerQueue}. */
export function createSteerQueue(): SteerQueue {
  let queue: SteerDelivery[] = [];
  const pending = new Set<SteerDelivery>();
  let closed = false;
  const take = (): SteerDelivery[] => {
    const out = queue;
    queue = [];
    return out;
  };
  return {
    push(message: SteerMessage): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const entry: SteerDelivery = {
          message,
          settle(delivered) {
            if (pending.delete(entry)) resolve(delivered);
          },
        };
        pending.add(entry);
        queue.push(entry);
      });
    },
    take,
    drain(): SteerMessage[] {
      const out = take();
      for (const entry of out) entry.settle(true);
      return out.map((entry) => entry.message);
    },
    close(): void {
      if (closed) return;
      closed = true;
      queue = [];
      for (const entry of pending) entry.settle(false);
    },
    undrained(): SteerMessage[] {
      return [...pending].map((entry) => entry.message);
    },
  };
}
