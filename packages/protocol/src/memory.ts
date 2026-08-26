/**
 * MemoryService — the operational surface of a workspace's execution memory.
 *
 * Deliberately narrow: whether memory is **healthy** and whether the durable
 * index queue is **moving**. Browsing, reading, searching, editing and revision
 * history left with the memory browser they existed to draw — the wiki is
 * markdown on disk, and the only thing that writes it is the agent.
 *
 * Present only when the kernel has memory configured; otherwise the methods
 * reject with a `capability_disabled` / memory-disabled `KernelError`.
 *
 * DTOs are protocol-owned (engine-independent): the kernel maps its memory
 * shapes onto these, so a UI depends only on `@clarvis/protocol`.
 */

import type { Timestamp } from "./common.ts";

/** Result of a standalone reindex: the index files whose managed link block was
 * created or rewritten. Empty means the navigation was already correct. */
export interface MemoryReindexResult {
  reindexed: string[];
}

/** How much a health finding matters. */
export type MemoryHealthSeverity = "error" | "warning" | "info";

/** One diagnostic about the memory store. */
export interface MemoryHealthFinding {
  /** Stable machine identity, e.g. `missing_profile`. */
  code: string;
  severity: MemoryHealthSeverity;
  /** The document or job it concerns; empty when tree-wide. */
  path: string;
  /** One-line statement of the problem. */
  message: string;
  /** What the owner can do about it. */
  suggested_action: string;
}

/**
 * A deterministic snapshot of memory's condition.
 *
 * @remarks Two calls with no intervening change produce the same totals and
 * findings, so a UI may re-render on refresh without diffing.
 */
export interface MemoryHealthReport {
  generated_at: Timestamp;
  totals: {
    documents: number;
    topics: number;
    memories: number;
    pending_jobs: number;
    failed_jobs: number;
  };
  counts: Record<MemoryHealthSeverity, number>;
  /** Ordered most severe first. */
  findings: MemoryHealthFinding[];
  /** True when lower-severity findings were dropped to stay within bounds. */
  truncated: boolean;
  /** Checks not run, because the state they read was unavailable. */
  skipped_codes: string[];
}

/**
 * Lifecycle of one durable index job.
 *
 * @remarks `retry_wait` is a failed attempt serving out its backoff; `failed`
 * is terminal until an operator retries, and the job is kept as the evidence
 * that something needs attention. A workspace with no indexer model has jobs
 * that are simply not runnable yet — that shows up as a count of pending work,
 * not as a state on the job.
 */
export type MemoryJobState = "pending" | "running" | "retry_wait" | "completed" | "failed";

/** Why the last attempt failed, in terms safe to render verbatim. */
export interface MemoryJobError {
  /** Stage that failed (`generate`, `validate`, `apply`, `reindex`, `commit`). */
  phase: string;
  /** Host-capped, sanitized message. Never a stack or a provider payload. */
  message: string;
  at: Timestamp;
}

/** One durable post-run index job. Jobs outlive the run that queued them. */
export interface MemoryJob {
  /** The run this job learns from; exactly one job exists per run. */
  run_id: string;
  state: MemoryJobState;
  /** Attempts made so far, including any in flight. */
  attempts: number;
  enqueued_at: Timestamp;
  updated_at: Timestamp;
  /** Set while `retry_wait`: when the next attempt becomes eligible. */
  next_attempt_at?: Timestamp;
  /** Most recent failure, when there is one. */
  last_error?: MemoryJobError;
  /** Short note about the last transition. */
  note?: string;
}

/** Filters for {@link MemoryService.jobs}. */
export interface MemoryJobFilter {
  state?: MemoryJobState;
  limit?: number;
}

/** Owner-facing operational surface for a workspace's execution memory. */
export interface MemoryService {
  /**
   * Deterministic diagnostics: totals plus findings ordered by severity.
   *
   * @remarks Model-free and read-only, so it is safe to call on every refresh.
   */
  health(): Promise<MemoryHealthReport>;

  /**
   * Regenerate every navigation block from the tree, scaffolding a missing
   * `PROFILE.md` or `TOPIC.md`.
   *
   * @returns the paths whose managed Contents block was created or rewritten;
   *   empty when the navigation was already settled.
   * @remarks The action {@link health} names. Its `missing_profile`,
   *   `missing_topic_index` and `stale_navigation` findings all suggest running
   *   a reindex, and this is the only way to run one that is not a side effect
   *   of a write. Model-free and deterministic: it reads each child's
   *   frontmatter description and rewrites the managed blocks, leaving the prose
   *   above them alone.
   */
  reindex(): Promise<MemoryReindexResult>;

  /**
   * List durable index jobs, newest first.
   *
   * @param filter - optional state restriction and page size.
   * @returns the jobs, plus how many sit in each state.
   * @remarks Available even when no indexer model resolves: a workspace that
   *   cannot currently learn still has a queue worth inspecting.
   */
  jobs(filter?: MemoryJobFilter): Promise<{
    jobs: MemoryJob[];
    counts: Record<MemoryJobState, number>;
  }>;

  /**
   * Put a failed index job back in the queue with a fresh attempt budget.
   *
   * @param runId - the run whose job to retry; jobs are one per run.
   * @returns the revived job, or null when there is no failed job for that run.
   */
  retryJob(runId: string): Promise<MemoryJob | null>;
}

/**
 * Payload of the `memory_ingest` run event — the post-run learning notice.
 *
 * @remarks Status-line material, never transcript material: it reports on work
 * that happens *after* the response, so a client shows it out of band and does
 * not replay it. Typed as a discriminated union on `phase` so a client switches
 * exhaustively instead of casting an opaque payload.
 */
export type MemoryIngestDetail =
  | { execution_id: string; phase: "started" }
  | {
      execution_id: string;
      /**
       * The run's intent was durably queued; the actual index pass runs later,
       * off the response path, in a job that outlives this run's event stream.
       */
      phase: "queued";
      /** See the `done` variant's field of the same name. */
      indexer_run_id?: string;
    }
  | {
      execution_id: string;
      phase: "done";
      /** Memory documents written (created or updated). */
      written?: number;
      /** Memory documents deleted. */
      deleted?: number;
      /** Whether the navigation index was restitched. */
      reindexed?: boolean;
      /** True when the pass declined to run (already indexed, no model). */
      skipped?: boolean;
      /** Short machine-ish reason accompanying `skipped`. */
      note?: string;
      /**
       * The indexer pass's own run id, when one ran.
       *
       * @remarks An index pass is a persisted run like any other, so this is a
       * link a client can follow with `runs.get(...)`. It is deliberately not a
       * trace-level parent edge: that mechanism lives on the *live* event stream
       * of the run being indexed, which has already closed by the time indexing
       * happens.
       */
      indexer_run_id?: string;
    }
  | {
      execution_id: string;
      phase: "failed";
      error?: string;
      /** See the `done` variant. The failed pass is the one worth opening. */
      indexer_run_id?: string;
    }
  | {
      execution_id: string;
      /** Queued but not yet runnable (e.g. no indexer model configured). */
      phase: "blocked";
      note?: string;
    };
