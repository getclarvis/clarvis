import type { MemoryJobSettlement } from "./job-broker.ts";
import type { Memory } from "./memory-contract.ts";

import { NOOP_LOGGER, sanitizeErrorMessage } from "@clarvis/capability";
import type { ExecutionRecord, Logger } from "@clarvis/capability";
import { storedExecutionToRunSnapshot } from "./run-snapshot.ts";
import { captureWorkspaceState } from "./workspace-state.ts";

/** Progress notice for a post-run memory index pass. Indexing runs after the
 * response is returned, so this is the only way a host can surface "your run
 * was learned from" (or that learning failed) to the user. */
export interface MemoryIngestNotice {
  execution_id: string;
  phase: "started" | "queued" | "done" | "failed" | "blocked";
  /** Set on phase "done": memory documents written (created or updated). */
  written?: number;
  /** Set on phase "done": memory documents deleted. */
  deleted?: number;
  /** Set on phase "done": whether the navigation index was restitched. */
  reindexed?: boolean;
  skipped?: boolean;
  note?: string;
  /** Set on phase "failed". */
  error?: string;
  /**
   * The indexer pass's own run id.
   *
   * @remarks An indexer pass is a persisted run like any other, so this is a
   * link a user can follow with `runs.get(...)`. It is carried on `failed` and
   * `queued` too, not only `done`: the entire point is that a pass which *died*
   * becomes inspectable, and a job backing off between retries is exactly when
   * someone wants to look at the one that just failed.
   */
  indexer_run_id?: string;
}

/**
 * Sink for {@link MemoryIngestNotice}s emitted across a post-run index pass —
 * the host's hook for surfacing "started/done/failed" to the user out of band.
 */
export type MemoryIngestListener = (notice: MemoryIngestNotice) => void;

/**
 * Translate one durable job's drain settlement into the {@link
 * MemoryIngestNotice} a host should show for it.
 *
 * @param job - the settlement a {@link MemoryJobBroker} delivered, keyed by
 *   `run_id` (the run's `execution_id`).
 * @returns a non-terminal `"queued"` notice for `"retry_wait"` (the job is
 *   still in flight, just backed off); `"failed"`/`"blocked"` carrying the
 *   job's `note`; or `"done"`, reporting `written`/`deleted`/`reindexed` when
 *   a real index pass ran, or `skipped: true` when the job converged without
 *   one (the already-indexed / no-snapshot shortcut in `drainIndexJobs`,
 *   which reports no counts).
 */
export function translateDrainSettlement(job: MemoryJobSettlement): MemoryIngestNotice {
  const link =
    job.indexer_run_id !== undefined ? { indexer_run_id: job.indexer_run_id } : ({} as const);
  switch (job.outcome) {
    case "retry_wait":
      return { execution_id: job.run_id, phase: "queued", ...link };
    case "failed":
      return {
        execution_id: job.run_id,
        phase: "failed",
        ...(job.note !== undefined ? { error: job.note } : {}),
        ...link,
      };
    case "blocked":
      return {
        execution_id: job.run_id,
        phase: "blocked",
        ...(job.note !== undefined ? { note: job.note } : {}),
      };
    case "completed":
    default: {
      const ran =
        job.written !== undefined || job.deleted !== undefined || job.reindexed !== undefined;
      return {
        execution_id: job.run_id,
        phase: "done",
        ...(ran
          ? {
              written: job.written ?? 0,
              deleted: job.deleted ?? 0,
              reindexed: job.reindexed ?? false,
            }
          : { skipped: true }),
        ...(job.note !== undefined ? { note: job.note } : {}),
        ...link,
      };
    }
  }
}

/**
 * Adapt a finished run's persisted record to a `RunSnapshot` and feed it to the
 * memory indexer, emitting {@link MemoryIngestNotice}s at each phase.
 *
 * @param a.memory - the owner's memory instance whose `index` performs the LLM
 *   pass plus file writes.
 * @param a.record - the already-persisted execution record to learn from.
 * @param a.workspaceRoot - workspace path, used both as the snapshot's workspace
 *   and to capture git state via {@link captureWorkspaceState}.
 * @param a.captureWorkspaceState - optional host probe seam; defaults to the
 *   real git-backed capture.
 * @param a.logger - where the enqueue outcome is reported; also handed to the
 *   git probe, whose failure is otherwise silent.
 * @param a.onNotice - optional listener; its own throws are swallowed so they
 *   cannot break the fire-and-forget contract.
 * @returns a promise that resolves once indexing settles.
 * @remarks Never rejects: the run is already persisted, so any indexing failure
 *   is caught, logged, and reported as a `"failed"` notice rather than
 *   propagated. Callers do not await it, keeping the LLM call and file writes off
 *   the response's critical path. See {@link storedExecutionToRunSnapshot}. Only
 *   the queueing this function performs — one bounded write via `memory.enqueue`
 *   — happens synchronously with the run; the expensive part (an inference call
 *   plus the tree mutation) runs later on the background worker, off the
 *   response path entirely. That split is what lets a finished run survive a
 *   process that dies before it could be learned from.
 */
export async function enqueueFinishedRun(a: {
  memory: Memory;
  /** Effective provider identity captured with the run. */
  providerKey?: string;
  record: ExecutionRecord;
  workspaceRoot: string;
  captureWorkspaceState?: typeof captureWorkspaceState;
  logger?: Logger;
  onNotice?: MemoryIngestListener;
}): Promise<void> {
  const notify = (notice: MemoryIngestNotice): void => {
    try {
      a.onNotice?.(notice);
    } catch {
      // A listener throw must not break the fire-and-forget contract.
    }
  };
  notify({ execution_id: a.record.id, phase: "started" });
  try {
    const workspaceState = await (a.captureWorkspaceState ?? captureWorkspaceState)(
      a.workspaceRoot,
      a.logger ?? NOOP_LOGGER,
    );
    const snapshot = storedExecutionToRunSnapshot(a.record, {
      workspace: a.workspaceRoot,
      ...(workspaceState !== undefined ? { workspaceState } : {}),
    });
    const job = await a.memory.enqueue(snapshot, {
      ...(a.providerKey !== undefined ? { providerKey: a.providerKey } : {}),
    });
    a.logger?.info(
      { event: "memory.run.enqueued", execution_id: a.record.id, state: job.state },
      "a finished run was queued for indexing; the pass itself runs later, off the response path",
    );
    notify({ execution_id: a.record.id, phase: "queued" });
  } catch (err) {
    a.logger?.warn(
      {
        event: "memory.run.enqueue_failed",
        execution_id: a.record.id,
        cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
      },
      "a finished run could not be queued for indexing; the run is already persisted, but memory will never cover it",
    );
    notify({
      execution_id: a.record.id,
      phase: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
