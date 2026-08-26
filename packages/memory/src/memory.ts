import { DEFAULT_BUDGETS } from "./config.ts";
import { drainIndexJobs } from "./drain.ts";
import { createFileMemoryStore } from "./file-store.ts";
import { health as inspectHealth, type MemoryHealthReport } from "./health.ts";
import { indexRun, MemoryIndexError } from "./indexer/run.ts";
import { boundRunSnapshot, type MemoryIndexJob, type MemoryJobState } from "./jobs.ts";
import { queryMemory, type MemoryQueryInput, type MemoryQueryResult } from "./query.ts";
import { reindex as reindexTree } from "./reindex.ts";
import { reviewDigest } from "./review.ts";
import { buildSeed } from "./seed.ts";
import { createMemoryTools } from "./tools.ts";
import type { MemoryBudgets, MemoryTx, RunSnapshot } from "./types.ts";
import type { CreateMemoryOptions, IndexReport, Memory, ReviewDigest } from "./memory-contract.ts";
import { systemClock, type MemoryClock } from "./clock.ts";
import { createRateLimiter, NOOP_LOGGER } from "@clarvis/capability";

/** Build the Memory facade over an injected persistence port. */
export function createMemory(opts: CreateMemoryOptions): Memory {
  const budgets: MemoryBudgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
  const store = opts.store;
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? NOOP_LOGGER;

  const reindex = (tx?: Pick<MemoryTx, "read" | "write" | "list">): Promise<string[]> =>
    tx === undefined
      ? store.exclusive((handle) => reindexTree(handle, logger))
      : reindexTree(tx, logger);

  const review = async (): Promise<ReviewDigest> => reviewDigest(await store.list());
  const owner = `${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}`;
  /**
   * One limiter for the life of this tree, not one per pass.
   *
   * @remarks A job the drain reports `blocked` stays `pending`, so it is due
   * again on the very next tick and blocks again for the same reason. The
   * suppression only means anything if the state that decides it outlives the
   * pass, which is why it is constructed here beside {@link owner} rather than
   * inside `drainIndexJobs`.
   */
  const admitBlocked = createRateLimiter();

  return {
    query: (input: MemoryQueryInput): Promise<MemoryQueryResult> =>
      queryMemory({ tx: store, input }),
    health: (): Promise<MemoryHealthReport> =>
      inspectHealth({ tx: store, now: clock.now(), jobs: store.jobs }),
    async enqueue(
      run: RunSnapshot,
      enqueueOptions: { providerKey?: string } = {},
    ): Promise<MemoryIndexJob> {
      const bounded = boundRunSnapshot(run);
      if (bounded.truncated !== undefined) {
        logger.debug(
          {
            event: "memory.enqueue.snapshot_bounded",
            run_id: run.run_id,
            dropped_tool_calls: bounded.truncated.dropped_tool_calls,
            original_bytes: bounded.truncated.original_bytes,
          },
          "the run snapshot exceeded its caps and was trimmed before storage",
        );
      }
      return store.exclusive((tx) =>
        tx.jobs.enqueue({
          run_id: run.run_id,
          snapshot: bounded.snapshot,
          at: clock.now(),
          provider_key: enqueueOptions.providerKey ?? "wiki:local",
        }),
      );
    },
    drain: (drainOpts = {}) =>
      drainIndexJobs({
        store,
        ...(opts.indexer !== undefined ? { indexer: opts.indexer } : {}),
        budgets,
        clock: drainOpts.clock ?? clock,
        owner,
        logger,
        admitBlocked,
        ...(drainOpts.limit !== undefined ? { limit: drainOpts.limit } : {}),
        ...(drainOpts.signal !== undefined ? { signal: drainOpts.signal } : {}),
      }),
    jobs: (filter?: { state?: MemoryJobState | readonly MemoryJobState[]; limit?: number }) =>
      store.jobs.list(filter),
    retryJob: (runId: string) => store.exclusive((tx) => tx.jobs.retry(runId, clock.now())),
    store,
    reindex,
    review,
    seed: (task?: string) =>
      buildSeed({ store, maxChars: budgets.seed_chars, ...(task !== undefined ? { task } : {}) }),
    tools: createMemoryTools({ store, reindex: (tx) => reindexTree(tx, logger) }),

    async index(run: RunSnapshot): Promise<IndexReport> {
      const indexer = await opts.indexer?.();
      if (indexer === undefined) {
        return {
          run_id: run.run_id,
          skipped: true,
          note: "no-indexer",
          written: [],
          deleted: [],
          reindexed: false,
        };
      }
      try {
        return await indexRun({ run, store, indexer, budgets, logger });
      } catch (err) {
        if (err instanceof MemoryIndexError) {
          return {
            run_id: run.run_id,
            skipped: false,
            note: err.message,
            written: [],
            deleted: [],
            reindexed: false,
          };
        }
        throw err;
      }
    },
  };
}

/** Convenience composition of {@link createMemory} over the markdown backend. */
export function createFileMemory(
  opts: Omit<CreateMemoryOptions, "store" | "clock"> & {
    root: string;
    /** One clock for both durable timestamps and live queue lease renewal. */
    clock?: MemoryClock | (() => number);
  },
): Memory {
  const { root, clock, ...rest } = opts;
  const memoryClock: MemoryClock | undefined =
    typeof clock === "function"
      ? { now: clock, after: systemClock.after.bind(systemClock) }
      : clock;
  const storeClock =
    clock === undefined ? undefined : typeof clock === "function" ? clock : () => clock.now();
  return createMemory({
    ...rest,
    ...(memoryClock !== undefined ? { clock: memoryClock } : {}),
    store: createFileMemoryStore({
      root,
      ...(storeClock !== undefined ? { clock: storeClock } : {}),
      ...(rest.logger !== undefined ? { logger: rest.logger } : {}),
    }),
  });
}
