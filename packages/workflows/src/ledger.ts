/**
 * The tree-wide token budget for a workflow. The loop does not aggregate usage
 * across separate `executeRun`s, so this ledger is the single source of truth for
 * how much the whole fan-out has spent and how much it may still spend.
 */
import type { OutputTokenBudget, OutputTokenReservation, Usage } from "@clarvis/capability";

/**
 * A live claim against a {@link WorkflowLedger}'s headroom, held for the
 * duration of one in-flight leader spawn.
 *
 * @remarks Exactly one of {@link WorkflowReservation.release} must be called per
 *   reservation, once (idempotent thereafter). Model calls settle their actual
 *   output against this reservation as they finish; {@link WorkflowReservation.reconcile}
 *   fills any accounting gap left by a scripted runner or test fake. `release`
 *   returns only unused headroom and never rolls back settled spend.
 */
export interface WorkflowReservation extends OutputTokenBudget {
  /** The provisional tokens this reservation holds against `remaining()`. */
  readonly amount: number;
  /** Output tokens settled inside this leader reservation. */
  spent(): number;
  /** Charge usage reported by a run fake or an accounting path outside model calls. */
  reconcile(usage: Usage): void;
  /** Clear this reservation's hold on the ledger. Safe to call more than once. */
  release(): void;
}

/**
 * A running tally of output tokens spent across every leader in a workflow tree,
 * against an optional ceiling.
 *
 * @remarks {@link WorkflowLedger.reserve} closes the gap between a leader being
 *   *approved to spawn* and its model calls actually settling: several
 *   `run_leader` calls dispatched in the same manager turn would otherwise all
 *   read the same pre-spend `remaining()` and could collectively spawn well past
 *   `total` before any of them completes. Reserving a fair share of the current
 *   headroom (divided across the run's concurrency cap) the moment a spawn is
 *   approved makes that check-and-decide step atomic: the sum of live
 *   reservations plus `spent()` can never exceed `total`.
 */
export interface WorkflowLedger extends OutputTokenBudget {
  /** Charge usage that was not already settled through a reservation. */
  add(usage: Usage): void;
  /** Output tokens spent across the tree so far (excludes live reservations). */
  spent(): number;
  /** Tokens left against {@link WorkflowLedger.total} after both actual spend and
   * live reservations, or `Infinity` when unbounded. */
  remaining(): number;
  /** The ceiling, or `null` when the tree is unbounded. */
  readonly total: number | null;
  /**
   * Reserve a fair share of the current headroom for one about-to-spawn leader.
   *
   * @param maxConcurrent - the run's leader-concurrency cap; the reservation is
   *   sized to `remaining() / (maxConcurrent + 1)` (at least 1 token, capped at
   *   whatever headroom remains). The extra share belongs to the manager, so a
   *   full wave of background leaders cannot provisionally starve its next
   *   supervision turn.
   * @returns the {@link WorkflowReservation}, or `null` when there is no headroom
   *   left to reserve (an unbounded ledger always succeeds).
   */
  reserve(maxConcurrent: number): WorkflowReservation | null;
}

/**
 * Create a {@link WorkflowLedger} bounded by `total` output tokens.
 *
 * @param total - the tree-wide output-token ceiling, or `null` for no bound.
 * @returns the ledger.
 */
export function createWorkflowLedger(total: number | null): WorkflowLedger {
  let spent = 0;
  let reserved = 0;
  const remaining = (): number =>
    total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent - reserved);

  const normalized = (tokens: number): number =>
    Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;

  const directReservation = (requested: number): OutputTokenReservation | null => {
    const wanted = normalized(requested);
    if (wanted < 1) return null;
    if (total === null) {
      let closed = false;
      return {
        amount: wanted,
        settle(used): void {
          if (closed) return;
          closed = true;
          spent += normalized(used);
        },
        release(): void {
          closed = true;
        },
      };
    }
    const amount = Math.min(wanted, remaining());
    if (amount < 1) return null;
    reserved += amount;
    let closed = false;
    return {
      amount,
      settle(used): void {
        if (closed) return;
        closed = true;
        reserved = Math.max(0, reserved - amount);
        spent += Math.min(amount, normalized(used));
      },
      release(): void {
        if (closed) return;
        closed = true;
        reserved = Math.max(0, reserved - amount);
      },
    };
  };

  return {
    total,
    add(usage: Usage): void {
      const charge = sumOutputTokens(usage);
      spent += total === null ? charge : Math.min(charge, remaining());
    },
    spent: (): number => spent,
    remaining,
    reserveOutput: directReservation,
    reserve(maxConcurrent: number): WorkflowReservation | null {
      if (total === null) {
        let childSpent = 0;
        let released = false;
        return {
          amount: 0,
          spent: () => childSpent,
          remaining: () => Number.POSITIVE_INFINITY,
          reserveOutput(requested): OutputTokenReservation | null {
            if (released) return null;
            const inner = directReservation(requested);
            if (inner === null) return null;
            let closed = false;
            return {
              amount: inner.amount,
              settle(used): void {
                if (closed || released) return;
                closed = true;
                const actual = normalized(used);
                childSpent += actual;
                inner.settle(actual);
              },
              release(): void {
                if (closed) return;
                closed = true;
                inner.release();
              },
            };
          },
          reconcile(usage): void {
            if (released) return;
            const missing = Math.max(0, sumOutputTokens(usage) - childSpent);
            childSpent += missing;
            spent += missing;
          },
          release(): void {
            released = true;
          },
        };
      }
      const headroom = remaining();
      if (headroom <= 0) return null;
      const amount = Math.min(
        headroom,
        Math.max(1, Math.ceil(headroom / (Math.max(1, maxConcurrent) + 1))),
      );
      reserved += amount;
      let childSpent = 0;
      let childReserved = 0;
      let released = false;
      return {
        amount,
        spent: () => childSpent,
        remaining: () => Math.max(0, amount - childSpent - childReserved),
        reserveOutput(requested): OutputTokenReservation | null {
          if (released) return null;
          const granted = Math.min(normalized(requested), amount - childSpent - childReserved);
          if (granted < 1) return null;
          childReserved += granted;
          let closed = false;
          return {
            amount: granted,
            settle(used): void {
              if (closed || released) return;
              closed = true;
              childReserved = Math.max(0, childReserved - granted);
              const actual = Math.min(granted, normalized(used));
              childSpent += actual;
              reserved = Math.max(0, reserved - actual);
              spent += actual;
            },
            release(): void {
              if (closed) return;
              closed = true;
              childReserved = Math.max(0, childReserved - granted);
            },
          };
        },
        reconcile(usage): void {
          if (released) return;
          const missing = Math.max(0, sumOutputTokens(usage) - childSpent);
          const actual = Math.min(missing, amount - childSpent - childReserved);
          childSpent += actual;
          reserved = Math.max(0, reserved - actual);
          spent += actual;
        },
        release(): void {
          if (released) return;
          released = true;
          reserved = Math.max(0, reserved - (amount - childSpent));
          childReserved = 0;
        },
      };
    },
  };
}

/** Sum the output tokens across a run's per-agent {@link Usage} breakdown. */
function sumOutputTokens(usage: Usage): number {
  return usage.by_agent.reduce((n, agent) => n + agent.output_tokens, 0);
}
