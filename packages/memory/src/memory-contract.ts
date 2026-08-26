import type { Logger } from "@clarvis/capability";

import type { MemoryClock } from "./clock.ts";
import type { MemoryDrainReport } from "./drain.ts";
import type { MemoryHealthReport } from "./health.ts";
import type { MemoryQueryInput, MemoryQueryResult } from "./query.ts";
import type {
  IndexerRuntimeResolver,
  MemoryBudgets,
  MemoryStore,
  MemoryToolDef,
  MemoryTx,
  RunSnapshot,
} from "./types.ts";
import type { MemoryIndexJob, MemoryJobState } from "./job-contract.ts";

/** Options for {@link import("./memory.ts").createMemory}. */
export interface CreateMemoryOptions {
  store: MemoryStore;
  indexer?: IndexerRuntimeResolver;
  budgets?: Partial<MemoryBudgets>;
  /** Live time source for queue timestamps and lease renewal. */
  clock?: MemoryClock;
  /**
   * Where every layer below this facade reports what it did.
   *
   * @remarks Threaded on to the drain, the index pass and the deterministic
   * reindex. Absent, each resolves to `NOOP_LOGGER`, so the behaviour is
   * byte-identical to before it existed.
   */
  logger?: Logger;
}

/** Outcome of a per-run index pass. */
export interface IndexReport {
  run_id: string;
  skipped: boolean;
  note?: string;
  written: string[];
  deleted: string[];
  reindexed: boolean;
  indexer_run_id?: string;
  continuation_blocker?: string | null;
}

/** Cheap, LLM-free overview of the tree for a host UI. */
export interface ReviewDigest {
  totals: { documents: number; topics: number; memories: number };
  recent: { path: string; description: string; updated_at: number }[];
  undescribed: string[];
}

/** Public facade over one workspace's memory tree. */
export interface Memory {
  index(run: RunSnapshot): Promise<IndexReport>;
  reindex(tx?: Pick<MemoryTx, "read" | "write" | "list">): Promise<string[]>;
  review(): Promise<ReviewDigest>;
  seed(task?: string): Promise<string | null>;
  query(input: MemoryQueryInput): Promise<MemoryQueryResult>;
  health(): Promise<MemoryHealthReport>;
  enqueue(run: RunSnapshot, options?: { providerKey?: string }): Promise<MemoryIndexJob>;
  drain(opts?: {
    limit?: number;
    signal?: AbortSignal;
    clock?: MemoryClock;
  }): Promise<MemoryDrainReport>;
  jobs(filter?: {
    state?: MemoryJobState | readonly MemoryJobState[];
    limit?: number;
  }): Promise<MemoryIndexJob[]>;
  retryJob(runId: string): Promise<MemoryIndexJob | null>;
  tools: MemoryToolDef[];
  store: MemoryStore;
}
