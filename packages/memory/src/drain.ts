/**
 * One pass of the index-job queue.
 *
 * The drain **never sleeps**. It does whatever is due at the instant it is
 * called, records when the rest becomes due, and returns. All waiting lives in
 * the worker's clock, which is what lets a test call `drain()` directly and
 * move time by hand rather than by `setTimeout`.
 */
import { indexRun, MemoryIndexError } from "./indexer/run.ts";
import {
  classifyFailure,
  DEFAULT_RETRY_POLICY,
  type MemoryIndexJob,
  type MemoryJobFailure,
  type MemoryJobLease,
  type MemoryRetryPolicy,
} from "./jobs.ts";
import type { MemoryClock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { randomUUID } from "node:crypto";
import { MemoryRecoveryRequiredError } from "./journal.ts";
import { MemoryPathError } from "./paths.ts";
import {
  bestEffort,
  createRateLimiter,
  NOOP_LOGGER,
  sanitizeText,
  type Logger,
  type Sampler,
} from "@clarvis/capability";
import type {
  IndexerRuntimeResolver,
  MemoryBudgets,
  MemoryMutationFence,
  MemoryStore,
  MemoryUnitOfWork,
  RunSnapshot,
} from "./types.ts";

/** How a single job's pass ended. */
export type MemoryDrainOutcome = "completed" | "retry_wait" | "failed" | "blocked";

/** What one drain pass did. */
export interface MemoryDrainReport {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  /**
   * Jobs that were due but could not run, through no fault of their own — no
   * indexer runtime is configured, or the store is awaiting recovery.
   *
   * @remarks Reported here rather than written onto the job: a blocked job is
   * an ordinary `pending` job in an unready workspace, and it consumes no
   * attempt, so it must not look like a failure that is using up its budget.
   */
  blocked: number;
  /** When the earliest remaining job becomes claimable. */
  next_due_at?: number;
  /**
   * Per-job outcomes, so a host can bridge a notice back to its run.
   *
   * @remarks `written`/`deleted`/`reindexed` are set only when a real index
   * pass ran (the `"completed"` outcome from the claimed branch, not the
   * converged already-indexed/no-snapshot shortcut) — their absence is what
   * distinguishes an actual pass from one that converged without invoking
   * the model.
   */
  jobs: {
    run_id: string;
    outcome: MemoryDrainOutcome;
    note?: string;
    written?: number;
    deleted?: number;
    reindexed?: boolean;
    /** The indexer pass's own run id, when one was started — including on a
     * failure, which is the case worth being able to inspect. */
    indexer_run_id?: string;
    /**
     * Why the pass could not continue the run it indexed, or `null` when it
     * did.
     *
     * @remarks Carried rather than computed-and-discarded. A pass that falls
     * back to the isolated form pays full price for the transcript the
     * provider would otherwise have served from its prefix cache, and until
     * this field existed the difference was invisible to every host: `planPass`
     * produced the reason, `IndexReport` carried it, and no `src` file read it.
     * Present only for a pass that actually ran.
     */
    continuation_blocker?: string | null;
  }[];
}

/** Why a due job could not run, through no fault of its own. */
export type MemoryJobBlockReason = "no_indexer" | "lease_lost" | "recovery" | "shutdown";

/** What each block reason means for the run whose learning is waiting. */
const BLOCK_CONSEQUENCE: Readonly<Record<MemoryJobBlockReason, string>> = {
  no_indexer:
    "an index job is due and this workspace has no indexer model; no attempt was consumed, so the learning is recovered whole once one is configured",
  lease_lost:
    "another worker reclaimed this index job mid-pass; whatever this pass wrote stands, and the claimant decides the rest",
  recovery:
    "memory is frozen awaiting recovery, so the index queue stopped; the claim was refunded and nothing was lost",
  shutdown:
    "the worker shut down mid-pass; the claim was refunded rather than failed, so the job keeps its full attempt budget",
};

/** Everything one drain pass needs. */
export interface DrainArgs {
  store: MemoryStore;
  /** Omit when the indexer cannot run: due jobs are reported blocked. */
  indexer?: IndexerRuntimeResolver;
  budgets: MemoryBudgets;
  /** Live clock used for every transition and lease-renewal timer. */
  clock?: MemoryClock;
  /** Fixed timestamp retained for deterministic direct-drain callers. */
  now?: number;
  /** Most jobs to attempt in one pass. */
  limit?: number;
  /** How long a claim holds before another worker may reclaim it. */
  leaseMs?: number;
  /** Identifies the claim holder in the job record. */
  owner: string;
  retry?: MemoryRetryPolicy;
  signal?: AbortSignal;
  /** How long job records survive; defaults to {@link DEFAULT_JOB_RETENTION}. */
  retention?: MemoryJobRetention;
  /**
   * Where the pass reports what it decided.
   *
   * @remarks This queue is durable and asynchronous by design, which is exactly
   * what makes its failures invisible: nothing on a run's response path ever
   * sees a retry, a give-up or a blocked workspace. The report this function
   * returns reaches only the worker that called it.
   */
  logger?: Logger;
  /**
   * Decides whether one `memory.job.blocked` record is emitted.
   *
   * @remarks A blocked job is a *steady state*, not an event: it stays
   * `pending`, so the very next pass finds it due again and blocks it again on
   * the same reason. Unlimited, one mistyped provider token in `settings.json`
   * is enough to fill an operator's whole retained diagnostic history with the
   * same sentence. Supply the limiter from wherever the tree lives — a limiter
   * created per pass suppresses nothing, which is exactly why the default here
   * is only a floor for a direct caller that drains once.
   */
  admitBlocked?: Sampler;
}

/** How long the queue keeps job records around. */
export interface MemoryJobRetention {
  /** Age at which a `completed` or `failed` record is dropped. */
  terminalMs: number;
  /** Age at which a still-unrun record is dropped. */
  pendingMs: number;
  /** Most recent failures kept whatever their age, as evidence. */
  keepFailed: number;
}

/**
 * Default queue retention.
 *
 * @remarks Unrun jobs are kept far longer than terminal ones, and on purpose:
 * a `pending` job in a workspace with no indexer runtime is not stale work, it is
 * learning waiting for a model to be configured, and dropping it early throws
 * away the only thing the durable queue exists to protect. Thirty days is long
 * enough for someone to come back and configure one, and short enough that a
 * workspace which never does stops accumulating run snapshots.
 *
 * The two survivorship rules answer different questions, which is why they are
 * separate fields rather than one age. `terminalMs` covers a *finished* job,
 * whose only remaining value is that someone may look at what happened — a week
 * is the span over which "what did that run learn?" is still a live question.
 * `keepFailed` overrides age entirely for the most recent failures, because a
 * failure is evidence and evidence that ages out is evidence lost exactly when a
 * pattern would have become visible; twenty is enough to show a repeating
 * failure without keeping a workspace's whole history of them.
 *
 * The sweep is skipped entirely on a pass that saw no job at all, which is the
 * steady state of a quiet workspace. `prune` reads and parses every job record
 * and does so inside the tree's exclusive lock, where it blocks the memory
 * panel, the wiki tools and any concurrent index pass — a cost worth paying
 * when there is a queue, and pure latency once a minute forever when there is
 * not.
 */
export const DEFAULT_JOB_RETENTION: MemoryJobRetention = {
  terminalMs: 7 * 24 * 60 * 60 * 1000,
  pendingMs: 30 * 24 * 60 * 60 * 1000,
  keepFailed: 20,
};

/** What the claim section decided for one iteration. */
type ClaimOutcome =
  | { kind: "none" }
  | { kind: "blocked"; job: MemoryIndexJob }
  | { kind: "lost"; job: MemoryIndexJob }
  | { kind: "converged"; job: MemoryIndexJob; note: string }
  | { kind: "claimed"; job: MemoryIndexJob; snapshot: RunSnapshot; lease: MemoryJobLease };

/**
 * Default number of jobs attempted per pass.
 *
 * @remarks Each job is a full `executeRun`, so this is a bound on how long one
 * drain occupies the worker rather than on how much work exists. A backlog is
 * not dropped by a small figure — the next pass takes the next few — so the
 * choice is only about how quickly a queue drains against how long a single
 * pass holds the interval. A handful keeps a pass short enough that the worker
 * stays responsive to its own interval and to shutdown.
 */
const DEFAULT_LIMIT = 5;

/**
 * Default claim lifetime.
 *
 * @remarks Comfortably longer than a slow index pass, and that direction is the
 * only one that matters: the lease exists so a *crashed* worker's job becomes
 * reclaimable, and expiring it early instead lets a second worker start a pass
 * the first is still running — two runs mutating one tree. Expiring it late only
 * delays recovery from a crash that already happened. So it is set past the
 * worst plausible pass (bounded in turn by `INDEXER_TOKEN_LIMIT` and
 * `INDEXER_ITERATION_LIMIT`), not near the typical one.
 */
const DEFAULT_LEASE_MS = 600_000;

/**
 * What a job's record says when the worker was torn down mid-pass.
 *
 * @remarks The claim is released rather than failed, so the attempt is
 * refunded: an interrupted worker is not the job's fault, and closing the app
 * twice during an index pass used to be enough to kill a job permanently.
 */
const SHUTDOWN_NOTE = "the worker shut down mid-pass";
const LOST_LEASE_NOTE = "the index claim was lost before settlement";

interface LeaseGuard {
  readonly signal: AbortSignal;
  readonly mutationFence: MemoryMutationFence;
  lost(): boolean;
  stop(): Promise<void>;
}

/** Keep one claim live while its indexer agent is between queue transactions. */
function keepLeaseAlive(args: {
  store: MemoryStore;
  clock: MemoryClock;
  runId: string;
  lease: MemoryJobLease;
  leaseMs: number;
  signal?: AbortSignal;
}): LeaseGuard {
  const controller = new AbortController();
  const signal =
    args.signal === undefined
      ? controller.signal
      : AbortSignal.any([args.signal, controller.signal]);
  const delay = Math.max(1, Math.floor(args.leaseMs / 2));
  let cancel: (() => void) | undefined;
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  let leaseLost = false;

  const lose = (): void => {
    leaseLost = true;
    if (!controller.signal.aborted) controller.abort(new Error(LOST_LEASE_NOTE));
  };
  const before = async (tx: MemoryUnitOfWork): Promise<boolean> => {
    if (leaseLost) return false;
    try {
      const renewed = await tx.jobs.renew(args.runId, args.clock.now(), args.lease, args.leaseMs);
      if (!renewed) lose();
      return renewed;
    } catch {
      lose();
      return false;
    }
  };
  const after = async (tx: MemoryUnitOfWork): Promise<boolean> => {
    if (leaseLost) return false;
    try {
      const refreshed = await tx.jobs.refreshOwnedAfterFence(
        args.runId,
        args.clock.now(),
        args.lease,
        args.leaseMs,
      );
      if (!refreshed) lose();
      return refreshed;
    } catch {
      lose();
      return false;
    }
  };
  const schedule = (): void => {
    if (stopped || leaseLost) return;
    cancel = args.clock.after(delay, () => {
      cancel = undefined;
      pending = args.store
        .exclusive(before)
        .then((renewed) => {
          if (!renewed) lose();
          else schedule();
        })
        .catch(() => lose());
    });
  };
  schedule();

  return {
    signal,
    mutationFence: { before, after },
    lost: () => leaseLost,
    async stop(): Promise<void> {
      stopped = true;
      cancel?.();
      cancel = undefined;
      await pending;
    },
  };
}

/**
 * Classify a thrown value into the failure the job record should carry.
 *
 * @param err - whatever the pass threw.
 * @returns the phase, a safe message, and whether retrying could ever help.
 * @remarks Messages are sanitized and the caller caps them. Stacks and
 *   provider payloads are deliberately excluded: this text lands in a
 *   workspace-local file a user may well paste into an issue.
 *
 *   The fallback phase is `apply` because that is what actually reaches it:
 *   {@link indexRun} tags its own generation and validation failures, so an
 *   untagged throw escaped `store.exclusive` or `tx.batch`. It used to say
 *   `generate`, a phase no unclassified error has ever described.
 */
function toFailure(err: unknown): MemoryJobFailure {
  const message = sanitizeText(err instanceof Error ? err.message : String(err));
  if (err instanceof MemoryIndexError) {
    return { phase: err.phase, error: message, ...(err.terminal ? { terminal: true } : {}) };
  }
  if (err instanceof MemoryPathError) return { phase: "apply", error: message, terminal: true };
  return { phase: "apply", error: message };
}

/**
 * Run one pass of the queue.
 *
 * @param args - the store, the optional indexer runtime, and the pass's bounds.
 * @returns what the pass did; see {@link MemoryDrainReport}.
 * @remarks Claim, index and settle are three separate critical sections rather
 *   than one exclusive section spanning the whole pass: `indexRun` runs a whole
 *   agent run and takes the tree lock only per tool call — starting it from
 *   inside an exclusive section would silently hold that lock for the
 *   tree lock itself, and nesting `exclusive` is explicitly not part of the
 *   store contract — a backend whose lock is a promise chain rather than a
 *   re-entrant one would deadlock. Readiness (an indexer runtime resolves) is
 *   checked *before* claiming, so an unready workspace never consumes an
 *   attempt or takes a lease it cannot honour. A job whose run was already
 *   folded in converges straight to `completed` without a second model call —
 *   the cheap guard that makes re-enqueueing and crash-reclaim safe. A
 *   {@link MemoryRecoveryRequiredError} thrown mid-pass is not the job's
 *   fault: its claim is refunded and the pass stops rather than failing the
 *   job. Neither is a shutdown — when `signal` is already aborted, whatever
 *   was thrown was thrown because *we* cancelled it, so the claim is refunded
 *   the same way. That is decided from our own signal rather than from the
 *   error's shape on purpose: every provider surfaces cancellation
 *   differently (a `DOMException` named `AbortError`, a plain `Error`, a
 *   bespoke wrapper), and recognising them one by one is a losing game.
 */
export async function drainIndexJobs(args: DrainArgs): Promise<MemoryDrainReport> {
  const policy = args.retry ?? DEFAULT_RETRY_POLICY;
  const limit = args.limit ?? DEFAULT_LIMIT;
  const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
  const clock: MemoryClock =
    args.clock ??
    (args.now === undefined
      ? systemClock
      : { now: () => args.now!, after: systemClock.after.bind(systemClock) });
  const now = (): number => clock.now();
  const logger = args.logger ?? NOOP_LOGGER;
  const admitBlocked = args.admitBlocked ?? createRateLimiter();
  const report: MemoryDrainReport = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    blocked: 0,
    jobs: [],
  };

  /**
   * Whether the host has cancelled this pass.
   *
   * @remarks A function rather than a hoisted boolean: the signal flips while
   * the pass awaits, and reading it through a call is also what stops control
   * flow analysis from narrowing `aborted` to `false` for the rest of an
   * iteration after the loop-top check has already returned.
   */
  const aborted = (): boolean => args.signal?.aborted === true;

  /**
   * Record and report a job that was due and did not run.
   *
   * @param runId - the job's run id.
   * @param reason - which of the four conditions applied.
   * @param note - the note the job record and the report already carry.
   * @remarks One place rather than six, because the four reasons are settled at
   * six call sites and a host reading `blocked` alone cannot tell "no model is
   * configured" from "another worker took this over".
   *
   * The report is always written; only the *record* is rate-limited, keyed by
   * run and reason so a second job, or the same job blocking for a new reason,
   * is never suppressed by the first.
   */
  const block = (runId: string, reason: MemoryJobBlockReason, note: string): void => {
    report.blocked += 1;
    report.jobs.push({ run_id: runId, outcome: "blocked", note });
    if (!admitBlocked(`${reason}\0${runId}`)) return;
    logger.info({ event: "memory.job.blocked", run_id: runId, reason }, BLOCK_CONSEQUENCE[reason]);
  };

  for (let i = 0; i < limit; i++) {
    if (aborted()) break;

    const indexer = await args.indexer?.();
    const claim: ClaimOutcome = await args.store.exclusive(async (tx) => {
      if (indexer === undefined) {
        const waiting = await tx.jobs.list({ state: ["pending", "retry_wait"], limit: 1 });
        const first = waiting[0];
        return first === undefined ? { kind: "none" } : { kind: "blocked", job: first };
      }
      const at = now();
      const lease: MemoryJobLease = { owner: args.owner, token: randomUUID() };
      const job = await tx.jobs.claim(at, { ms: leaseMs, ...lease });
      if (job === null) return { kind: "none" };
      const converge = async (note: string): Promise<ClaimOutcome> =>
        (await tx.jobs.complete(job.run_id, now(), note, lease))
          ? { kind: "converged", job, note }
          : { kind: "lost", job };
      if (job.provider_key === undefined) {
        return converge("provider-selection-unknown");
      }
      const currentProviderKey = indexer.memoryProviderKey ?? "wiki:local";
      if (job.provider_key !== currentProviderKey) {
        return converge("provider-selection-changed");
      }
      if (indexer.memoryProvider !== undefined && indexer.memoryProvider.writeTools === undefined) {
        return converge("provider-read-only");
      }
      if (await tx.wasIndexed(job.run_id)) {
        return converge("already-indexed");
      }
      if (job.snapshot === undefined) {
        return converge("no-snapshot");
      }
      return { kind: "claimed", job, snapshot: job.snapshot, lease };
    });

    if (claim.kind === "none") break;
    if (claim.kind === "blocked") {
      block(claim.job.run_id, "no_indexer", "the indexer runtime is not configured");
      break;
    }
    if (claim.kind === "lost") {
      report.claimed += 1;
      block(claim.job.run_id, "lease_lost", LOST_LEASE_NOTE);
      continue;
    }
    if (claim.kind === "converged") {
      report.claimed += 1;
      report.completed += 1;
      report.jobs.push({ run_id: claim.job.run_id, outcome: "completed", note: claim.note });
      logger.debug(
        { event: "memory.job.converged", run_id: claim.job.run_id, note: claim.note },
        "an index job settled without a model call; the run it names needed no pass",
      );
      continue;
    }

    const { job, snapshot, lease } = claim;
    report.claimed += 1;
    if (indexer === undefined) continue;

    const leaseGuard = keepLeaseAlive({
      store: args.store,
      clock,
      runId: job.run_id,
      lease,
      leaseMs,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    try {
      const result = await indexRun({
        run: snapshot,
        agentInstanceId: job.agent_instance_id,
        executionId: job.indexer_execution_id,
        continueFrom: job.indexer_continue_from,
        priorExecutions: job.indexer_prior_executions,
        store: args.store,
        indexer,
        budgets: args.budgets,
        signal: leaseGuard.signal,
        mutationFence: leaseGuard.mutationFence,
        logger,
      });
      await leaseGuard.stop();
      const settled = await args.store.exclusive((tx) =>
        tx.jobs.complete(job.run_id, now(), result.note, lease),
      );
      if (!settled) {
        block(job.run_id, "lease_lost", LOST_LEASE_NOTE);
        continue;
      }
      report.completed += 1;
      report.jobs.push({
        run_id: job.run_id,
        outcome: "completed",
        written: result.written.length,
        deleted: result.deleted.length,
        reindexed: result.reindexed,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(result.indexer_run_id !== undefined ? { indexer_run_id: result.indexer_run_id } : {}),
        ...(result.continuation_blocker !== undefined
          ? { continuation_blocker: result.continuation_blocker }
          : {}),
      });
    } catch (err) {
      await leaseGuard.stop();
      if (leaseGuard.lost()) {
        block(job.run_id, "lease_lost", LOST_LEASE_NOTE);
        continue;
      }
      if (err instanceof MemoryRecoveryRequiredError) {
        await args.store.exclusive((tx) =>
          tx.jobs.release(job.run_id, now(), "memory is awaiting recovery", lease),
        );
        block(job.run_id, "recovery", "memory is awaiting recovery");
        break;
      }
      if (aborted()) {
        await args.store.exclusive((tx) =>
          tx.jobs.release(job.run_id, now(), SHUTDOWN_NOTE, lease),
        );
        block(job.run_id, "shutdown", SHUTDOWN_NOTE);
        break;
      }
      const failure = toFailure(err);
      const failedAt = now();
      const next = classifyFailure(job, failure, policy, failedAt);
      const settled = await args.store.exclusive((tx) =>
        tx.jobs.fail(job.run_id, failedAt, failure, next, lease),
      );
      if (!settled) {
        block(job.run_id, "lease_lost", LOST_LEASE_NOTE);
        continue;
      }
      const indexerRunId = err instanceof MemoryIndexError ? err.indexerRunId : undefined;
      logger.warn(
        {
          event: "memory.index.failed",
          run_id: job.run_id,
          ...(indexerRunId !== undefined ? { indexer_run_id: indexerRunId } : {}),
          phase: failure.phase,
          terminal: failure.terminal === true,
          attempts: job.attempts,
          max_attempts:
            failure.phase === "validate" ? policy.maxValidateAttempts : policy.maxAttempts,
          next_state: next.state,
          ...(next.state === "retry_wait" ? { not_before: next.not_before } : {}),
        },
        next.state === "failed"
          ? "an index pass failed and will not be retried; that run's learning is dropped"
          : "an index pass failed and is queued for another attempt; the run's learning is still held",
      );
      if (next.state === "failed") {
        report.failed += 1;
        logger.error(
          {
            event: "memory.index.gave_up",
            run_id: job.run_id,
            phase: failure.phase,
            attempts: job.attempts,
            history_phases: job.history.map((attempt) => attempt.phase),
          },
          "an index job exhausted its retry budget; what that run could have taught this workspace is lost for good",
        );
      } else report.retried += 1;
      report.jobs.push({
        run_id: job.run_id,
        outcome: next.state === "failed" ? "failed" : "retry_wait",
        note: `${failure.phase}: ${failure.error}`,
        // Carried on the failure path deliberately: a pass that died is exactly
        // the one worth opening, and its trace is persisted like any run's.
        ...(indexerRunId !== undefined ? { indexer_run_id: indexerRunId } : {}),
      });
    }
  }

  if (!aborted() && (report.claimed > 0 || report.jobs.length > 0)) {
    const retention = args.retention ?? DEFAULT_JOB_RETENTION;
    const pruneAt = now();
    let removed = 0;
    await bestEffort(
      async () => {
        removed = await args.store.exclusive((tx) =>
          tx.jobs.prune({
            terminalBefore: pruneAt - retention.terminalMs,
            keepFailed: retention.keepFailed,
            pendingBefore: pruneAt - retention.pendingMs,
          }),
        );
      },
      { operation: "memory_job_prune", logger },
    );
    logger.debug(
      { event: "memory.prune", removed, kept_failed: retention.keepFailed },
      "the index queue dropped job records past their retention",
    );
  }

  const due = await args.store.jobs.nextDueAt();
  if (due !== undefined) report.next_due_at = due;

  return report;
}
