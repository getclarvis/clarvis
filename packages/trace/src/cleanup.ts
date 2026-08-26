import type { Logger } from "@clarvis/capability";
import type { TraceCleanupCounters, TraceStore } from "./trace-store.ts";
import { unref } from "@clarvis/capability";

const MS_PER_DAY = 86_400_000;

export const DEFAULT_MAX_TRACE_CLEANUP_ENTRIES = 10_000;

/** A session-reference scan used to decide whether destructive trace cleanup is safe. */
export interface ProtectedExecutionIds {
  ids: ReadonlySet<string>;
  /** False when the reference catalog could not be scanned completely. */
  complete: boolean;
}

/** Configuration for a {@link TraceCleanup} retention sweeper. */
export interface TraceCleanupOptions {
  /** The store whose expired executions are pruned. */
  store: TraceStore;
  /** Retention window in days; `0` disables cleanup entirely. */
  ttlDays: number;
  /** Maximum executions deleted per {@link TraceStore.cleanup} call. */
  batchSize: number;
  /** Optional logger for cleanup progress and failures. */
  logger?: Logger;
  /** Maximum records deleted by one run before yielding to the next interval. */
  maxEntriesPerRun?: number;
  /** Execution ids retained because a durable session still references them. */
  protectedExecutionIds?: () => ProtectedExecutionIds;
}

/**
 * A background sweeper that periodically prunes executions older than
 * `ttlDays` from a {@link TraceStore}, batching deletes to bound each pass.
 *
 * @remarks A `ttlDays` of `0` makes every operation a no-op; the interval timer
 *   is {@link unref | unref'd} so it never keeps the process alive.
 */
export class TraceCleanup {
  private handle: ReturnType<typeof setInterval> | null = null;
  /** @param opts - the store, retention window, batch size and logger. */
  constructor(private readonly opts: TraceCleanupOptions) {}

  /**
   * Run an immediate sweep, then repeat every `intervalMs`.
   *
   * @param intervalMs - period between sweeps (floored at 1ms).
   * @remarks A no-op when `ttlDays` is `0` or a timer is already running.
   */
  start(intervalMs: number): void {
    if (this.opts.ttlDays === 0 || this.handle !== null) return;
    this.runOnce();
    this.handle = setInterval(
      () => {
        this.runOnce();
      },
      Math.max(1, intervalMs),
    );
    unref(this.handle);
  }

  /** Stop the recurring sweep; safe to call when not started. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Perform a single retention sweep synchronously, looping batched deletes
   * until a short batch signals the backlog is drained.
   *
   * @returns the number of executions deleted this sweep.
   * @remarks The pass count is not a constant of its own: it is
   *   `ceil(maxEntriesPerRun / batchSize)`, the fewest batches that can reach
   *   the per-run entry ceiling, floored at one. So the two bounds an operator
   *   sets are the only ones, and no amount of looping exceeds either. A
   *   remaining backlog (logged as a warning) is left for the next interval. A no-op returning `0` when `ttlDays` is `0`. Any
   *   store error is caught and logged, returning the count deleted so far
   *   rather than throwing.
   */
  runOnce(): number {
    if (this.opts.ttlDays === 0) return 0;
    const cutoffMs = Date.now() - this.opts.ttlDays * MS_PER_DAY;
    const normalizeBound = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value)
        ? Math.min(DEFAULT_MAX_TRACE_CLEANUP_ENTRIES, Math.max(1, Math.floor(value)))
        : fallback;
    const batch = normalizeBound(this.opts.batchSize, DEFAULT_MAX_TRACE_CLEANUP_ENTRIES);
    const maxEntries = normalizeBound(
      this.opts.maxEntriesPerRun,
      DEFAULT_MAX_TRACE_CLEANUP_ENTRIES,
    );
    const maxPasses = Math.max(1, Math.ceil(maxEntries / batch));
    let total = 0;
    const counters: TraceCleanupCounters = { records: 0, journals: 0, leases: 0, tmp: 0 };
    const protectedExecutionIds = this.opts.protectedExecutionIds?.();
    if (protectedExecutionIds?.complete === false) {
      this.opts.logger?.warn(
        { ttl_days: this.opts.ttlDays },
        "trace cleanup skipped because durable session references could not be scanned completely",
      );
      return 0;
    }
    try {
      let pass = 0;
      for (; pass < maxPasses; pass += 1) {
        const deleted = this.opts.store.cleanup(
          cutoffMs,
          Math.min(batch, maxEntries - total),
          counters,
          protectedExecutionIds?.ids,
        );
        total += deleted;
        if (deleted < batch) break;
      }
      if (pass >= maxPasses) {
        this.opts.logger?.warn(
          {
            deleted: total,
            cutoff_ms: cutoffMs,
            ttl_days: this.opts.ttlDays,
            max_passes: maxPasses,
            max_entries: maxEntries,
          },
          "trace cleanup hit the per-run pass cap; a backlog remains and will continue next interval",
        );
      } else if (total > 0) {
        this.opts.logger?.info(
          {
            deleted: total,
            journals_removed: counters.journals,
            leases_reclaimed: counters.leases,
            cutoff_ms: cutoffMs,
            ttl_days: this.opts.ttlDays,
          },
          "trace cleanup removed expired executions",
        );
      }
      return total;
    } catch (err) {
      this.opts.logger?.error(
        { cause: err instanceof Error ? err.message : String(err), ttl_days: this.opts.ttlDays },
        "trace cleanup pass failed; will retry next interval",
      );
      return total;
    }
  }
}
