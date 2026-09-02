/**
 * The cumulative leader admission ledger for one manager run.
 *
 * @remarks Concurrency bounds how many leaders may run at once; this ledger
 * bounds how many may be registered over the manager's whole lifetime. A
 * caller reserves a complete semantic unit (one ad-hoc leader, one work-item
 * batch, or one round) before registering any child, so exhaustion can never
 * produce a partially spawned round.
 */

/** A held all-or-nothing admission for a bounded group of leaders. */
export interface WorkflowLeaderReservation {
  /** Convert one held slot into a registered leader. */
  consume(): boolean;
  /** Give back every slot that was not consumed. Idempotent. */
  release(): void;
  /** Slots still held by this reservation. */
  remaining(): number;
}

/** Tree-wide cumulative leader count and admission authority. */
export interface WorkflowLeaderCount {
  readonly limit: number;
  /** Leaders whose supervision handles were successfully registered. */
  started(): number;
  /** Capacity not started or held by an active atomic admission. */
  remaining(): number;
  /** Hold `amount` slots atomically, or return `null` when the group will not fit. */
  reserve(amount: number): WorkflowLeaderReservation | null;
}

/** Build a cumulative leader ledger for one manager run. */
export function createWorkflowLeaderCount(limit: number): WorkflowLeaderCount {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("workflow leader limit must be a positive integer");
  }
  let started = 0;
  let held = 0;

  return {
    limit,
    started: () => started,
    remaining: () => limit - started - held,
    reserve(amount: number): WorkflowLeaderReservation | null {
      if (!Number.isInteger(amount) || amount < 1) return null;
      if (amount > limit - started - held) return null;
      held += amount;
      let remaining = amount;
      let released = false;
      return {
        consume(): boolean {
          if (released || remaining === 0) return false;
          remaining -= 1;
          held -= 1;
          started += 1;
          return true;
        },
        release(): void {
          if (released) return;
          released = true;
          held -= remaining;
          remaining = 0;
        },
        remaining: () => remaining,
      };
    },
  };
}
