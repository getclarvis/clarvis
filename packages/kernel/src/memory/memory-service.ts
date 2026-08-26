import type { MemoryFactory } from "@clarvis/memory/capability";
import type { Memory, MemoryIndexJob } from "@clarvis/memory";
import type {
  MemoryHealthReport,
  MemoryJob,
  MemoryJobFilter,
  MemoryJobState,
  MemoryReindexResult,
  MemoryService,
} from "@clarvis/protocol";
import { memoryError } from "./memory-errors.ts";
import { mapMemoryFailure } from "./memory-errors.ts";

/** Hard ceiling on {@link MemoryService.jobs}'s page size, clamping any larger caller-supplied `limit`. */
const MAX_LIMIT = 100;

/**
 * Project a domain job onto the wire {@link MemoryJob}.
 *
 * @remarks The snapshot is deliberately not projected: it is the run's payload,
 * often large, and nothing in a queue view needs it.
 */
function toJob(j: MemoryIndexJob): MemoryJob {
  const last = j.history[j.history.length - 1];
  return {
    run_id: j.run_id,
    state: j.state,
    attempts: j.attempts,
    enqueued_at: j.enqueued_at,
    updated_at: j.updated_at,
    ...(j.not_before !== undefined ? { next_attempt_at: j.not_before } : {}),
    ...(last !== undefined
      ? { last_error: { phase: last.phase, message: last.error, at: last.at } }
      : {}),
    ...(j.note !== undefined ? { note: j.note } : {}),
  };
}

/** Configuration for {@link createMemoryService}. */
export interface MemoryServiceConfig {
  /**
   * Builds a per-owner {@link Memory}; `undefined` when the host wired no
   * memory subsystem at all, which disables every method.
   *
   * @remarks The service resolves through
   * {@link MemoryFactory.forOwnerControlPlane}, not `forOwner`: diagnosing the
   * wiki and inspecting its queue must keep working in a workspace that has
   * memory enabled but no indexer model. Only learning depends on the model.
   */
  factory: MemoryFactory | undefined;
  /** Owner scope whose memory wiki this service operates over (via {@link MemoryFactory}). */
  owner: string;
}

/**
 * Adapt the per-owner memory wiki to the protocol {@link MemoryService}, mapping
 * domain documents onto wire types.
 *
 * @param cfg - the memory {@link MemoryFactory | factory} and the owner scope; see
 *   {@link MemoryServiceConfig}.
 * @returns a {@link MemoryService} whose every method resolves the owner's
 *   {@link Memory} on demand and fails with `capability_disabled` when no factory
 *   is configured.
 * @remarks Mutating methods (`write`, `edit`, `delete`) run under the store's
 *   exclusive lock and re-run {@link Memory.reindex} so navigation link blocks
 *   stay in sync, returning the list of paths whose blocks were regenerated.
 */
export function createMemoryService(cfg: MemoryServiceConfig): MemoryService {
  /**
   * Resolve the owner's {@link Memory}.
   *
   * @returns the owner-scoped memory wiki.
   * @throws {@link kernelError | KernelException} `capability_disabled` when
   *   memory is absent or switched off for this workspace — but *not* merely
   *   because no indexer model resolves.
   */
  function mem(): Memory {
    const m = cfg.factory?.forOwnerControlPlane(cfg.owner);
    if (m === undefined) {
      throw memoryError("MEMORY_NOT_CONFIGURED", "memory is not configured for this workspace");
    }
    return m;
  }

  /**
   * Run one service operation, translating package failures into tagged kernel
   * errors.
   *
   * @param context - the document under operation, attached to any failure so a
   *   client can point at it.
   * @param fn - the operation, given the resolved memory instance.
   */
  async function guard<T>(context: { path?: string }, fn: (m: Memory) => Promise<T>): Promise<T> {
    try {
      return await fn(mem());
    } catch (err) {
      throw mapMemoryFailure(err, context);
    }
  }

  return {
    /**
     * Run deterministic diagnostics over the tree and the index queue.
     *
     * @returns totals plus findings ordered most severe first.
     */
    async health(): Promise<MemoryHealthReport> {
      return guard({}, (m) => m.health());
    },

    /**
     * Regenerate every navigation block, scaffolding a missing `PROFILE.md` or
     * `TOPIC.md`.
     *
     * @returns the paths whose managed block was created or rewritten.
     * @remarks Delegates to the package's own `reindex` without a transaction
     *   handle, which takes the tree's exclusive lock for its duration — so it
     *   serializes against an index pass rather than racing one. This is what
     *   {@link MemoryService.health}'s `missing_profile`,
     *   `missing_topic_index` and `stale_navigation` findings ask for.
     */
    async reindex(): Promise<MemoryReindexResult> {
      return guard({}, async (m) => ({ reindexed: await m.reindex() }));
    },

    /**
     * List durable index jobs, newest first, with per-state counts.
     *
     * @param filter - optional state restriction and page size; `limit` is
     *   clamped to {@link MAX_LIMIT}.
     */
    async jobs(
      filter?: MemoryJobFilter,
    ): Promise<{ jobs: MemoryJob[]; counts: Record<MemoryJobState, number> }> {
      return guard({}, async (m) => {
        const limit = Math.min(filter?.limit ?? MAX_LIMIT, MAX_LIMIT);
        const found = await m.jobs({
          ...(filter?.state !== undefined ? { state: filter.state } : {}),
          limit,
        });
        return { jobs: found.map(toJob), counts: await m.store.jobs.counts() };
      });
    },

    /**
     * Put a failed index job back in the queue.
     *
     * @param runId - the run whose job to retry.
     * @returns the revived job, or null when no failed job exists for that run.
     */
    async retryJob(runId: string): Promise<MemoryJob | null> {
      return guard({}, async (m) => {
        const revived = await m.retryJob(runId);
        return revived === null ? null : toJob(revived);
      });
    },
  };
}
