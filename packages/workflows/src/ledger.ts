/**
 * The auxiliary token budget for a workflow. The loop does not aggregate usage
 * across the manager's in-process children and separate leader `executeRun`s,
 * so this ledger is the single source of truth for how much that fan-out has
 * spent and may still spend. The manager remains on its primary run budget.
 */
import type { OutputTokenBudget, OutputTokenReservation, Usage } from "@clarvis/capability";

/**
 * Cap each model-call reservation to a fair share of its parent's live headroom.
 *
 * @param parent - the shared ledger or leader reservation being partitioned.
 * @param maxConcurrent - the maximum number of model calls that can compete at
 *   this boundary.
 * @returns an adapter that reserves atomically from `parent` and returns unused
 *   output headroom as soon as that model call settles.
 * @remarks This is deliberately per call rather than per agent lifetime. An
 *   agent can therefore reuse headroom released by a sibling on its next model
 *   call, while a capless provider request can never reserve the entire parent
 *   ahead of concurrent siblings.
 */
export function createFairShareOutputBudget(
  parent: OutputTokenBudget,
  maxConcurrent: number,
): OutputTokenBudget {
  const concurrency = Math.max(1, Math.floor(maxConcurrent));
  return {
    remaining: () => parent.remaining(),
    reserveOutput(requested): OutputTokenReservation | null {
      const available = parent.remaining();
      if (available < 1) return null;
      const share = Number.isFinite(available)
        ? Math.max(1, Math.ceil(available / concurrency))
        : requested;
      return parent.reserveOutput(Math.min(requested, share));
    },
  };
}

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
 * A running tally of output tokens spent across every leader in a workflow,
 * against an optional ceiling.
 *
 * @remarks {@link WorkflowLedger.reserve} closes the gap between a leader being
 *   admitted by the concurrency semaphore and its model calls actually settling:
 *   concurrent leaders would otherwise all read the same pre-spend `remaining()`
 *   and could collectively run past `total`. Reserving a fair share of the
 *   current headroom before model dispatch makes that check-and-decide step
 *   atomic, while leaders still queued for a semaphore permit hold no headroom:
 *   the sum of live reservations plus `spent()` can never exceed `total`.
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
   * Reserve a fair share of current headroom for one top-level auxiliary subtree.
   *
   * @param maxConcurrent - the maximum concurrent top-level auxiliary consumers;
   *   the reservation is
   *   sized to `remaining() / maxConcurrent` (at least 1 token, capped at
   *   whatever headroom remains). The manager has an independent primary-run
   *   budget and therefore takes no share from this ledger.
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
        Math.max(1, Math.ceil(headroom / Math.max(1, maxConcurrent))),
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
