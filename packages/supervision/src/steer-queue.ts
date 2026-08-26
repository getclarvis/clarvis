/**
 * A push-side {@link SteerSource}: the queue a parent's `agent_steer` writes to
 * and the child's own loop drains at the top of its next iteration.
 *
 * @remarks The loop's steer contract is pull-only by design (`drain()`, no
 * arrival signal), and this does not change that — it only adds the writer the
 * kernel's own queue has and the loop had no local equivalent of. Deliberately
 * not shared with `@clarvis/kernel`'s steer queue: that one belongs to the run's
 * human channel, this one to one child, and fusing them would tie a per-child
 * control port to the kernel's lifecycle.
 */
import type { SteerMessage, SteerSource } from "@clarvis/capability";

/** A {@link SteerSource} a parent can push onto. */
export interface SteerQueue extends SteerSource {
  /**
   * Queue a message for the child.
   *
   * @returns `false` once the queue is closed — the child has settled and a
   *   steer for it is a plain refusal, never an error.
   */
  push(message: SteerMessage): boolean;
  /** Messages queued but never drained, for a teardown warning. */
  undrained(): readonly SteerMessage[];
  /** Stop accepting pushes. Already-queued messages stay drainable, so closing
   * on settle never discards a steer the child could still have taken. */
  close(): void;
}

/** Create an empty {@link SteerQueue}. */
export function createSteerQueue(): SteerQueue {
  let pending: SteerMessage[] = [];
  let closed = false;

  return {
    push(message: SteerMessage): boolean {
      if (closed) return false;
      pending.push(message);
      return true;
    },
    drain(): SteerMessage[] {
      const out = pending;
      pending = [];
      return out;
    },
    undrained: () => pending,
    close(): void {
      closed = true;
    },
  };
}
