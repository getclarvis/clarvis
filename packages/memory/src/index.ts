/**
 * @clarvis/memory — workspace-local execution memory as a navigable markdown wiki.
 *
 * The tree IS the memory: `PROFILE.md` (workspace compilation) →
 * `<topic>/TOPIC.md` (domain compilation) → `<topic>/<sub>/MEMORY.md` (full
 * detail). The model reads it (seed injects the PROFILE; tools drill down) and
 * edits it directly; a deterministic, stateless reindex keeps only the
 * navigation sections in sync from each file's frontmatter `description:`.
 * A per-run indexer folds finished runs into leaves autonomously. No vectors, no
 * JSON state — a small run-dedup ledger aside. Leaf library: the host injects the
 * LLM (GenerateFn), the persistence port (MemoryStore) and adapts its run format
 * to RunSnapshot. Its only Clarvis dependencies are the two leaves —
 * `@clarvis/capability` (the contract and the shared redaction rules) and
 * `@clarvis/paths` (the directory vocabulary); nothing here imports the engine.
 */
export type {
  ToolCallEvent,
  WorkspaceState,
  RunSnapshot,
  IndexerRuntime,
  IndexerRuntimeResolver,
  DocKind,
  MemoryAuthority,
  DocFrontmatter,
  MemoryDoc,
  MemoryToolResult,
  MemoryToolDef,
  MemoryBudgets,
  GrepHit,
  MemoryTx,
  MemoryBatch,
  MemoryBatchInput,
  MemoryRevisionReader,
  MemoryRevisionTx,
  MemoryJobReader,
  MemoryJobTx,
  MemoryJobPruneOptions,
  MemoryUnitOfWork,
  MemoryStore,
} from "./types.ts";
export type { CreateMemoryOptions, IndexReport, ReviewDigest, Memory } from "./memory-contract.ts";
export { createFileMemory, createMemory } from "./memory.ts";
export { MEMORY_DEFAULTS, DEFAULT_BUDGETS } from "./config.ts";
export { createFileMemoryStore, type CreateFileMemoryStoreOptions } from "./file-store.ts";
export { MEMORY_STORAGE_LIMITS, MemoryStorageLimitError } from "./storage-limits.ts";
export {
  normalizeMemoryPath,
  memoryDocKind,
  compareMemoryPaths,
  MemoryPathError,
} from "./paths.ts";
export { buildDigest, renderDigest, type RunDigest } from "./digest.ts";
/**
 * The text redactor this package applies before anything it persists.
 *
 * @remarks Only `sanitizeText` is re-exported. `sanitizeDeep` deliberately is
 *   not: its default redactor is the replay-safe *tool payload* rule set, which
 *   matches the generic secret words only when quoted, so a one-argument call
 *   reached through this barrel would redact strictly less than the wiki's own
 *   rules do. Memory's own call sites import it from `@clarvis/capability` and
 *   pass {@link sanitizeText} explicitly; a consumer that needs the deep walk
 *   should do the same rather than inherit a weaker default from this name.
 */
export { sanitizeText } from "@clarvis/capability";
export { parseFrontmatter, serializeDoc, readDescription } from "./frontmatter.ts";
export { reindex, planReindex, BLOCK_BEGIN, BLOCK_END, type ReindexChange } from "./reindex.ts";
export {
  compareRevisionsNewestFirst,
  digestBody,
  type MemoryRevision,
  type MemoryRevisionSource,
} from "./revisions.ts";
export {
  decideRecovery,
  JOURNAL_VERSION,
  MemoryRecoveryRequiredError,
  type MemoryBatchCommit,
  type MemoryJournalOp,
  type MemoryJournalRecord,
  type MemoryRecoveryEntry,
  type MemoryRecoveryOutcome,
  type MemoryRecoveryReport,
} from "./journal.ts";
export { reindexView } from "./batch.ts";
export {
  queryMemory,
  DEFAULT_QUERY_CONFIG,
  QUERY_FIELDS,
  type MemoryQueryConfig,
  type MemoryQueryField,
  type MemoryQueryHit,
  type MemoryQueryInput,
  type MemoryQueryResult,
} from "./query.ts";
export { extractTitle } from "./tree.ts";
export {
  health,
  DEFAULT_HEALTH_CONFIG,
  HEALTH_CODES,
  type MemoryHealthCode,
  type MemoryHealthConfig,
  type MemoryHealthFinding,
  type MemoryHealthReport,
  type MemoryHealthSeverity,
} from "./health.ts";
export {
  checkWrite,
  type MemoryWriteIntent,
  type MemoryWriteOperation,
  type PolicyDecision,
} from "./policy.ts";
export { systemClock, type MemoryClock } from "./clock.ts";
export {
  drainIndexJobs,
  DEFAULT_JOB_RETENTION,
  type MemoryDrainOutcome,
  type MemoryDrainReport,
  type MemoryJobRetention,
} from "./drain.ts";
export {
  createMemoryJobBroker,
  type MemoryJobBroker,
  type MemoryJobBrokerOptions,
  type MemoryJobSettlement,
} from "./job-broker.ts";
export {
  appendAttempt,
  boundRunSnapshot,
  classifyFailure,
  isJobPrunable,
  retryDelayMs,
  DEFAULT_RETRY_POLICY,
  DEFAULT_SNAPSHOT_LIMITS,
  MAX_JOB_HISTORY,
  type MemoryIndexJob,
  type MemoryJobAttempt,
  type MemoryJobFailure,
  type MemoryJobLease,
  type MemoryJobPhase,
  type MemoryJobState,
  type MemoryJobTransition,
  type MemoryRetryPolicy,
  type MemorySnapshotLimits,
} from "./jobs.ts";
export { MemoryIndexError } from "./indexer/run.ts";
export {
  createIndexWorker,
  type MemoryIndexWorker,
  type MemoryIndexWorkerOptions,
} from "./worker.ts";
export { isIndexFile } from "./tree.ts";
export { SEED_OPEN_TAG, SEED_MAX_CHARS } from "./seed.ts";
export {
  INDEXER_SYSTEM,
  INDEXER_ITERATION_LIMIT,
  INDEXER_TOKEN_LIMIT,
  MEMORY_INDEXER_AGENT,
} from "./indexer/request.ts";
export {
  memoryLeafPathSchema,
  memoryWritablePathSchema,
  memoryConfigSchema,
  budgetsSchema,
  type MemoryConfig,
} from "./schemas.ts";
