/**
 * The background index worker: the timer, the coalescing, the shutdown.
 *
 * One worker exists per memory tree, for the life of the process. It holds a
 * *resolver* rather than a `Memory`, so a settings edit — or a model appearing
 * where there was none — takes effect on the next tick without anyone
 * rebuilding the worker, and a rebuilt instance never leaves a second timer
 * running over the same tree.
 */
import type { MemoryClock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { MemoryDrainReport } from "./drain.ts";
import type { Memory } from "./memory-contract.ts";
import {
  createRateLimiter,
  detachObserved,
  NOOP_LOGGER,
  sanitizeErrorMessage,
  type Logger,
} from "@clarvis/capability";

/** Construction inputs for {@link createIndexWorker}. */
export interface MemoryIndexWorkerOptions {
  /**
   * Resolves the memory instance to drain, or undefined when memory is off.
   *
   * @remarks Called per tick on purpose — see the module note.
   */
  resolve: () => Memory | undefined;
  clock?: MemoryClock;
  /** How often to drain when nothing has poked the worker. */
  intervalMs?: number;
  /**
   * Where a drain pass's totals and a drain failure are reported.
   *
   * @remarks Widened from a structural `{ info, warn }` to the shared
   * {@link Logger} port so the worker's records carry the same `event` field
   * and the same bindings as everything else in the package.
   */
  logger?: Logger;
  /** Fires per settled job, so a host can bridge the outcome back to its run. */
  onJobSettled?: (outcome: MemoryDrainReport["jobs"][number]) => void;
}

/** A running background worker. */
export interface MemoryIndexWorker {
  /** Drain immediately, then keep draining on the interval. */
  start(): void;
  /**
   * Ask for a drain soon.
   *
   * @remarks Coalescing: a poke during an in-flight drain queues **at most**
   * one follow-up pass, so a burst of finished runs cannot stack up passes.
   */
  poke(): void;
  /** Stop the timer, cancel in-flight model work, and await settlement. */
  stop(): Promise<void>;
}

/** Default gap between unprompted drains. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Build the per-tree index worker.
 *
 * @param opts - the resolver plus clock, interval and logging.
 * @returns a {@link MemoryIndexWorker}; nothing runs until `start`.
 */
export function createIndexWorker(opts: MemoryIndexWorkerOptions): MemoryIndexWorker {
  const clock = opts.clock ?? systemClock;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = opts.logger ?? NOOP_LOGGER;

  let inFlight: Promise<void> | null = null;
  let again = false;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  const controller = new AbortController();
  const admitIdlePass = createRateLimiter();

  /** How many of a pass's jobs actually moved. */
  function settled(report: MemoryDrainReport): number {
    return report.completed + report.retried + report.failed;
  }

  /**
   * Report the totals of one pass.
   *
   * @param report - what the drain just returned.
   * @remarks A pass that settled nothing and blocked something is a steady
   *   state, not an event, and it recurs for as long as the misconfiguration
   *   that causes it lasts — so it is rate-limited, keyed by how many jobs are
   *   stuck, while a pass that moved anything is always reported. The blocked
   *   jobs themselves are limited one layer down, in `drainIndexJobs`.
   */
  function reportPass(report: MemoryDrainReport): void {
    if (report.jobs.length === 0) return;
    if (settled(report) === 0 && !admitIdlePass(`blocked:${String(report.blocked)}`)) return;
    logger.info(
      {
        event: "memory.drain.pass",
        claimed: report.claimed,
        completed: report.completed,
        retried: report.retried,
        failed: report.failed,
        blocked: report.blocked,
      },
      "one pass of the durable index queue settled",
    );
  }

  /**
   * When the next unprompted pass is due.
   *
   * @param report - what the drain just returned.
   * @returns the delay to arm the timer with.
   * @remarks Waking exactly when the next job is due honours a short retry
   *   backoff promptly and costs a quiet tree one timer per interval. A
   *   *blocked* job has no backoff to honour: it stays `pending`, so its due
   *   time is the moment it was enqueued, already in the past — which made the
   *   worker re-drain with no delay, forever, for as long as the workspace had
   *   no indexer model configured. Nothing about that job can change until the
   *   configuration does, so a pass that settled nothing and blocked something
   *   waits the full interval instead. A finished run still pokes the worker,
   *   so real work never waits on this.
   */
  function nextDelay(report: MemoryDrainReport): number {
    if (settled(report) === 0 && report.blocked > 0) return intervalMs;
    if (report.next_due_at === undefined) return intervalMs;
    return Math.min(intervalMs, Math.max(0, report.next_due_at - clock.now()));
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = clock.after(Math.max(0, delayMs), () => {
      cancelTimer = null;
      requestPass("memory_worker_timer");
    });
  }

  /**
   * Run one drain attempt and report when the next unprompted pass is due.
   *
   * @remarks Scheduling belongs to {@link requestPass}, after it has consumed a
   *   coalesced poke. Arming a timer here left that timer behind an immediate
   *   follow-up; when the follow-up lasted longer than the interval, the stale
   *   timer queued another follow-up and could keep the worker draining without
   *   a new poke. Every exit still returns a delay, including the one where the
   *   resolver yields nothing, so a model appearing later is picked up normally.
   */
  async function runOnce(): Promise<number> {
    try {
      const memory = opts.resolve();
      if (memory === undefined) return intervalMs;
      const report = await memory.drain({ signal: controller.signal, clock });
      reportPass(report);
      for (const outcome of report.jobs) {
        try {
          opts.onJobSettled?.(outcome);
        } catch {
          /* a listener throw must not break the worker */
        }
      }
      return nextDelay(report);
    } catch (err) {
      logger.warn(
        {
          event: "memory.drain.failed",
          cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "a pass of the index queue threw; the queue is durable, so this retries on the next pass",
      );
      return intervalMs;
    }
  }

  function requestPass(operation: string): void {
    if (stopped) return;
    if (inFlight !== null) {
      again = true;
      return;
    }
    // A manual poke may arrive while the periodic timer is armed. The immediate
    // pass supersedes it; only this pass's eventual outcome may arm the next one.
    cancelTimer?.();
    cancelTimer = null;
    const complete = (nextDelay: number): void => {
      inFlight = null;
      if (stopped) return;
      if (again) {
        again = false;
        requestPass("memory_worker_followup");
        return;
      }
      schedule(nextDelay);
    };
    const pass = runOnce().then(
      (nextDelay) => complete(nextDelay),
      (error: unknown) => {
        complete(intervalMs);
        throw error;
      },
    );
    inFlight = pass;
    // Observe each newly-created pass exactly once. A poke storm while this
    // promise is pending only flips `again`; attaching one best-effort await per
    // poke would retain one Promise reaction per poke until the drain settles.
    detachObserved(() => pass, { operation, logger });
  }

  return {
    start() {
      requestPass("memory_worker_start");
    },
    poke() {
      requestPass("memory_worker_poke");
    },
    async stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      controller.abort();
      await inFlight?.catch(() => undefined);
    },
  };
}
