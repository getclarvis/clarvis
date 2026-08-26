/**
 * `@clarvis/trace` — how a Clarvis run's trace is *recorded and kept*.
 *
 * @remarks
 * The split against `@clarvis/capability` is deliberate and is the whole reason
 * this package exists separately: the contract owns the **vocabulary** — who
 * *declares* an event (`TraceKind`, `TraceDetailMap`, `TracePort`, `Trace`,
 * `TraceEvent`, `ExecutionRecord`) — and this package owns the
 * **implementation** — who *writes* one: the recording handle, the JSON store,
 * the crash journal and its recovery, the wire mapper, the display caps and the
 * retention sweeper.
 *
 * {@link TraceHandle} satisfies the contract's `TracePort` **structurally**, so
 * nothing here adapts to reach a capability; the engine passes the handle
 * straight through.
 *
 * It depends on `@clarvis/capability` and `@clarvis/paths` and on no external
 * package at all — only `node:fs`, `node:os`, `node:path` and `node:crypto`.
 */
export { TraceCleanup, DEFAULT_MAX_TRACE_CLEANUP_ENTRIES } from "./cleanup.ts";
export type { TraceCleanupOptions } from "./cleanup.ts";
export { generateExecutionId } from "./execution-id.ts";
export {
  JOURNAL_VERSION,
  JOURNAL_SUFFIX,
  JOURNAL_CORRUPT_SUFFIX,
  JOURNAL_OVERSIZED_SUFFIX,
  createRunJournal,
} from "./journal.ts";
export type {
  JournalHeader,
  RunJournal,
  OpenJournalOptions,
  CreateRunJournalOptions,
} from "./journal.ts";
export {
  UNCOMPLETED_TOOL_RESULT,
  writerStillRunning,
  parseJournalChunks,
  repairUnsettledToolCalls,
  journalToRecord,
} from "./journal-recovery.ts";
export type {
  JournalParseFailure,
  JournalParseLimitFailure,
  JournalParseSuccess,
  JournalParseResult,
  JournalParseLimits,
} from "./journal-recovery.ts";
export {
  createJsonTraceStore,
  DEFAULT_MAX_TRACE_OWNER_INDEXES,
  DEFAULT_MAX_TRACE_OWNER_INDEX_ENTRIES,
  DEFAULT_MAX_TRACE_RECORD_BYTES,
  MAX_TRACE_RECORD_BYTES,
  MAX_TRACE_SUMMARY_BYTES,
  MAX_TRACE_LIST_LIMIT,
  MAX_TRACE_LIST_OFFSET,
  MAX_TRACE_RECOVERY_EVENTS,
  MAX_TRACE_RECOVERY_JOURNAL_BYTES,
  MAX_TRACE_RECOVERY_JOURNALS,
  MAX_TRACE_RECOVERY_SCAN_ENTRIES,
  MAX_TRACE_RECOVERY_TOTAL_BYTES,
  MAX_TRACE_CLEANUP_SCAN_ENTRIES,
} from "./json-trace-store.ts";
export type { JsonTraceStoreOptions } from "./json-trace-store.ts";
export { buildRecord } from "./record-builder.ts";
export type { BuildRecordInput } from "./record-builder.ts";
export { mapEntry, mapTrace } from "./trace-mapper.ts";
export { resolveTraceStore } from "./trace-store-factory.ts";
export type { ResolveTraceStoreOptions, ResolvedTraceStore } from "./trace-store-factory.ts";
export { parseStoredJson, recordToSummary, sortDescPaginate } from "./trace-store.ts";
export type {
  StoredExecution,
  StoredSummary,
  ListResult,
  TraceCleanupCounters,
  TraceRecoveryReport,
  TraceStore,
  JournalingTraceStore,
} from "./trace-store.ts";
export {
  TRUNCATED_SUFFIX,
  RESULT_MAX,
  MODEL_RESPONSE_MAX,
  SUMMARY_MAX,
  DIFF_MAX,
  LIVE_CHUNK_MAX,
  ARGS_MAX,
  ARGS_TOTAL_MAX,
  DETAIL_MAX_ENTRIES,
  DETAIL_MAX_DEPTH,
  DETAIL_TRUNCATED_KEY,
  truncate,
  truncateTail,
  capDetail,
} from "./cap-detail.ts";
export { iterationSpanId, deriveEventSpan } from "./event-span.ts";
export type { SpanPhase, SpanKind, EventSpan } from "./event-span.ts";
export { createTrace } from "./in-memory-trace.ts";
export type { TraceHandle } from "./trace-handle.ts";
