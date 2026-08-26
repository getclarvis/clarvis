/**
 * Durable index jobs: the record, and the **pure** policy that governs it.
 *
 * A finished run is worth learning from, but learning costs a model call that
 * must not sit on the response's critical path. The gap between "the run
 * ended" and "memory absorbed it" is therefore crossed by a durable record
 * rather than an in-flight promise: a process that dies mid-pass loses nothing
 * it had accepted responsibility for.
 *
 * Everything here is a pure function over a job plus a timestamp, so retry
 * schedules and give-up rules are tested without a clock, a timer or a disk.
 */
import { sanitizeDeep, sanitizeText } from "@clarvis/capability";
import { truncate } from "./text.ts";
import type { RunSnapshot, ToolCallEvent } from "./run-contract.ts";
import type {
  MemoryIndexJob,
  MemoryJobAttempt,
  MemoryJobFailure,
  MemoryJobTransition,
} from "./job-contract.ts";
export type {
  MemoryIndexJob,
  MemoryJobAttempt,
  MemoryJobFailure,
  MemoryJobLease,
  MemoryJobPhase,
  MemoryJobState,
  MemoryJobTransition,
} from "./job-contract.ts";

/** Failures kept on a job before the oldest are dropped. */
export const MAX_JOB_HISTORY = 5;

/** Maximum jobs retained by one queue listing, across every store adapter. */
export const DEFAULT_MEMORY_JOB_PAGE_SIZE = 200;

/** Longest error string stored on a job. */
const ERROR_MAX_CHARS = 500;

/** How a failing job is rescheduled. */
export interface MemoryRetryPolicy {
  /** Claims a job may consume before it is given up on. */
  maxAttempts: number;
  /**
   * Separate, lower cap on `validate` failures.
   *
   * @remarks A model that cannot produce a valid operation array twice will not
   * produce one on the fifth try, and each attempt costs a full inference.
   */
  maxValidateAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected so the schedule is exact in tests; `Math.random` in production. */
  jitter: () => number;
}

/** The retry policy used when a host supplies none. */
export const DEFAULT_RETRY_POLICY: MemoryRetryPolicy = {
  maxAttempts: 5,
  maxValidateAttempts: 2,
  baseDelayMs: 30_000,
  maxDelayMs: 900_000,
  jitter: Math.random,
};

/**
 * How long to wait before the next attempt.
 *
 * @param attempts - claims consumed so far, including the one that just failed.
 * @param policy - the governing {@link MemoryRetryPolicy}.
 * @returns a delay in milliseconds: exponential backoff with full jitter,
 *   clamped to `maxDelayMs`.
 * @remarks Full jitter rather than a fixed schedule, so several workspaces
 *   recovering from the same provider outage do not retry in lockstep.
 */
export function retryDelayMs(attempts: number, policy: MemoryRetryPolicy): number {
  const exponential = policy.baseDelayMs * Math.pow(2, Math.max(0, attempts - 1));
  return Math.round(Math.min(policy.maxDelayMs, exponential) * policy.jitter());
}

/**
 * Decide a failing job's next state.
 *
 * @param job - the job as it was claimed, with `attempts` already incremented.
 * @param failure - what went wrong.
 * @param policy - the governing retry policy.
 * @param now - current epoch ms.
 * @returns the transition to apply.
 * @remarks The single place the give-up rules live, so the drain has no
 *   branching of its own and the rules are testable without running a pass.
 */
export function classifyFailure(
  job: MemoryIndexJob,
  failure: MemoryJobFailure,
  policy: MemoryRetryPolicy,
  now: number,
): MemoryJobTransition {
  if (failure.terminal === true) return { state: "failed" };
  if (job.attempts >= policy.maxAttempts) return { state: "failed" };
  if (failure.phase === "validate") {
    const validateFailures = job.history.filter((a) => a.phase === "validate").length + 1;
    if (validateFailures >= policy.maxValidateAttempts) return { state: "failed" };
  }
  return { state: "retry_wait", not_before: now + retryDelayMs(job.attempts, policy) };
}

/**
 * Record a failure on a job, keeping the history bounded and the text safe.
 *
 * @param job - the job to append to.
 * @param failure - what went wrong.
 * @param now - current epoch ms.
 * @returns the new history array.
 */
export function appendAttempt(
  job: MemoryIndexJob,
  failure: MemoryJobFailure,
  now: number,
): MemoryJobAttempt[] {
  const attempt: MemoryJobAttempt = {
    at: now,
    phase: failure.phase,
    error: truncate(failure.error, ERROR_MAX_CHARS),
  };
  return [...job.history, attempt].slice(-MAX_JOB_HISTORY);
}

/**
 * The failed jobs kept as evidence whatever their age.
 *
 * @param jobs - every job record the store holds.
 * @param keepFailed - how many of the most recent failures to protect.
 * @returns their run ids.
 * @remarks Shared by both store backends because "most recent" has to mean the
 *   same thing in each. It orders by `updated_at` — when the job *failed* —
 *   rather than by enqueue order, which is what the file store happens to sort
 *   by: a run queued long ago but failed a minute ago is recent evidence, and
 *   ordering by `enqueued_at` would discard it while keeping an older failure.
 */
export function keptFailureIds(jobs: readonly MemoryIndexJob[], keepFailed: number): Set<string> {
  return new Set(
    jobs
      .filter((j) => j.state === "failed")
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, keepFailed)
      .map((j) => j.run_id),
  );
}

/**
 * Whether a job record may be dropped, given the pass's age bounds.
 *
 * @param job - the record under consideration.
 * @param opts - the governing bounds; the caller has already excluded whatever
 *   `keepFailed` protects.
 * @returns true when the record is past the bound that applies to its state.
 * @remarks Shared by both store backends so "prunable" cannot come to mean two
 *   different things. `running` is never prunable at any age: it is claimed,
 *   and a lease that outlives its worker is reclaimed rather than deleted.
 */
export function isJobPrunable(
  job: Pick<MemoryIndexJob, "state" | "updated_at">,
  opts: { terminalBefore: number; pendingBefore?: number },
): boolean {
  if (job.state === "completed" || job.state === "failed") {
    return job.updated_at < opts.terminalBefore;
  }
  if (job.state === "pending" || job.state === "retry_wait") {
    return opts.pendingBefore !== undefined && job.updated_at < opts.pendingBefore;
  }
  return false;
}

/** Caps applied to a snapshot before it is stored. */
export interface MemorySnapshotLimits {
  maxToolCalls: number;
  maxExcerptChars: number;
  maxFinalAnswer: number;
  maxTask: number;
  maxSteering: number;
  maxSteeringChars: number;
}

/** Snapshot caps used when a host supplies none. */
export const DEFAULT_SNAPSHOT_LIMITS: MemorySnapshotLimits = {
  maxToolCalls: 500,
  maxExcerptChars: 600,
  maxFinalAnswer: 4000,
  maxTask: 8000,
  maxSteering: 20,
  maxSteeringChars: 400,
};

/** A snapshot reduced to what is safe and worth storing. */
export interface BoundedSnapshot {
  snapshot: RunSnapshot;
  /**
   * What bounding dropped, when it dropped anything.
   *
   * @remarks Reported on the enqueue log line rather than stored on the job:
   *   the durable record carried it for months with no reader, which reads as a
   *   contract a consumer could act on and none ever could.
   */
  truncated?: { dropped_tool_calls: number; original_bytes: number };
}

/**
 * Sanitize and bound a run snapshot for durable storage.
 *
 * @param run - the host's snapshot of a finished run.
 * @param limits - caps to apply; defaults to {@link DEFAULT_SNAPSHOT_LIMITS}.
 * @returns the bounded snapshot, plus what was dropped when anything was.
 * @remarks Redaction runs **first**, so nothing unredacted is ever written to
 *   disk even transiently. When tool calls must be dropped, the first and last
 *   are kept: a run's opening moves and its ending are what carry the lesson,
 *   while the middle of a long loop is mostly repetition.
 */
export function boundRunSnapshot(
  run: RunSnapshot,
  limits: Partial<MemorySnapshotLimits> = {},
): BoundedSnapshot {
  const caps = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  const clean = sanitizeDeep(run, sanitizeText);
  const originalBytes = JSON.stringify(clean).length;
  const originalCalls = clean.tool_calls.length;

  let calls: ToolCallEvent[] = clean.tool_calls;
  if (calls.length > caps.maxToolCalls) {
    const head = Math.floor(caps.maxToolCalls / 5);
    calls = [...calls.slice(0, head), ...calls.slice(calls.length - (caps.maxToolCalls - head))];
  }
  const tool_calls = calls.map((call) => ({
    ...call,
    result_excerpt: truncate(call.result_excerpt, caps.maxExcerptChars),
  }));

  const snapshot: RunSnapshot = {
    ...clean,
    task: truncate(clean.task, caps.maxTask),
    tool_calls,
    ...(clean.final_answer !== undefined
      ? { final_answer: truncate(clean.final_answer, caps.maxFinalAnswer) }
      : {}),
    ...(clean.steering !== undefined
      ? {
          steering: clean.steering
            .slice(0, caps.maxSteering)
            .map((s) => truncate(s, caps.maxSteeringChars)),
        }
      : {}),
  };

  const dropped = originalCalls - tool_calls.length;
  return {
    snapshot,
    ...(dropped > 0 || JSON.stringify(snapshot).length < originalBytes
      ? { truncated: { dropped_tool_calls: dropped, original_bytes: originalBytes } }
      : {}),
  };
}
