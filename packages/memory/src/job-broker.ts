/**
 * A per-run subscription over the durable index queue's job settlements.
 *
 * {@link MemoryIndexWorker.onJobSettled} already fires once per job in every
 * {@link MemoryDrainReport}, but has no notion of "a caller wants to know when
 * *this* run's job settles" — this module adds exactly that, so a host can
 * bridge a background drain's eventual outcome back to the run that queued
 * it without the worker or the drain loop knowing anything about runs.
 */
import type { MemoryClock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { MemoryDrainReport } from "./drain.ts";

/** One job's settlement, as reported by a drain pass. */
export type MemoryJobSettlement = MemoryDrainReport["jobs"][number];

/** Outcomes that end a run's subscription once delivered. */
const TERMINAL_OUTCOMES = new Set<MemoryJobSettlement["outcome"]>([
  "completed",
  "failed",
  "blocked",
]);

/** Construction inputs for {@link createMemoryJobBroker}. */
export interface MemoryJobBrokerOptions {
  clock?: MemoryClock;
  /**
   * Leak guard, not a UX bound: a subscription with no terminal settlement
   * within this many ms is dropped automatically.
   *
   * @remarks Defaults comfortably beyond {@link DEFAULT_RETRY_POLICY}'s
   *   worst-case cumulative backoff, so a job still retrying is never cut off
   *   early; it exists only so a job that never settles (or a run_id nothing
   *   ever enqueues) cannot hold a subscription forever.
   */
  timeoutMs?: number;
}

/** Delivers a durable index job's eventual settlement(s) to its run. */
export interface MemoryJobBroker {
  /**
   * Subscribe for one run's settlement(s), keyed by `(owner, run_id)`.
   *
   * @remarks Safe — and expected — to call before the run's job is enqueued:
   *   subscribing after risks missing a settlement the worker's own recurring
   *   timer drains immediately. A `"retry_wait"` delivery does not
   *   unsubscribe; exactly one terminal delivery (`completed`/`failed`/
   *   `blocked`) does, automatically. A prior subscription for the same
   *   `(owner, run_id)` is replaced, not stacked. The owner is part of the key
   *   because caller-supplied execution ids need only be unique within one
   *   owner scope; two tenants may legitimately use the same id.
   * @returns a canceller; safe to call more than once.
   */
  subscribe(
    owner: string,
    runId: string,
    listener: (settlement: MemoryJobSettlement) => void,
  ): () => void;
  /**
   * Publish one job's settlement.
   *
   * @remarks A `run_id` with no subscriber is silently dropped — the job is
   *   already durably persisted regardless of whether anyone is listening,
   *   so a missing subscriber changes nothing about correctness. Never
   *   throws: a listener's own exception is swallowed so one bad subscriber
   *   cannot break the caller's drain loop.
   */
  publish(owner: string, settlement: MemoryJobSettlement): void;
  /** Cancel every pending subscription owned by one owner without closing others. */
  closeOwner(owner: string): void;
  /**
   * Cancel every pending leak guard and permanently close the broker.
   *
   * @remarks Idempotent. Subscriptions attempted after close are inert and do
   *   not allocate another timer; publishes remain harmless no-ops.
   */
  close(): void;
}

/**
 * Default leak-guard timeout: comfortably beyond any realistic backoff.
 *
 * @remarks A guard against a subscription nobody ever settles, not a deadline
 * for the work — so firing it is always a bug report, never a normal outcome,
 * and the value only has to sit past every legitimate wait. The longest of those
 * is a job working through its retry backoff, which is why the figure is in tens
 * of minutes rather than the seconds a single pass takes. Setting it near the
 * expected wait would cancel live subscriptions; setting it further out only
 * delays noticing a leak.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Build a {@link MemoryJobBroker}.
 *
 * @param opts - an injectable clock (for deterministic tests) and leak-guard
 *   timeout; see {@link MemoryJobBrokerOptions}.
 */
export function createMemoryJobBroker(opts: MemoryJobBrokerOptions = {}): MemoryJobBroker {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const subscriptions = new Map<
    string,
    { listener: (settlement: MemoryJobSettlement) => void; cancelTimeout: () => void }
  >();
  let closed = false;

  const subscriptionKey = (owner: string, runId: string): string => JSON.stringify([owner, runId]);

  return {
    subscribe(owner, runId, listener) {
      if (closed) return () => undefined;
      const key = subscriptionKey(owner, runId);
      subscriptions.get(key)?.cancelTimeout();
      const cancelTimeout = clock.after(timeoutMs, () => {
        subscriptions.delete(key);
      });
      subscriptions.set(key, { listener, cancelTimeout });
      return () => {
        const entry = subscriptions.get(key);
        if (entry?.listener === listener) {
          entry.cancelTimeout();
          subscriptions.delete(key);
        }
      };
    },
    publish(owner, settlement) {
      if (closed) return;
      const key = subscriptionKey(owner, settlement.run_id);
      const entry = subscriptions.get(key);
      if (entry === undefined) return;
      if (TERMINAL_OUTCOMES.has(settlement.outcome)) {
        entry.cancelTimeout();
        subscriptions.delete(key);
      }
      try {
        entry.listener(settlement);
      } catch {
        /* a listener throw must not break the publisher's drain loop */
      }
    },
    closeOwner(owner) {
      if (closed) return;
      const prefix = JSON.stringify([owner]).slice(0, -1) + ",";
      for (const [key, entry] of subscriptions) {
        if (!key.startsWith(prefix)) continue;
        entry.cancelTimeout();
        subscriptions.delete(key);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of subscriptions.values()) entry.cancelTimeout();
      subscriptions.clear();
    },
  };
}
