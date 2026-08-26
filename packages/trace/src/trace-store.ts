import type {
  ContextSnapshotEntry,
  ExecutionRecord,
  ExecutionStatus,
  TokenAccumulator,
} from "@clarvis/capability";
import type { OpenJournalOptions, RunJournal } from "./journal.ts";
import { PersistenceError } from "@clarvis/capability";

/**
 * Parse persisted JSON, re-framing a syntax error as a {@link PersistenceError}
 * that names the corrupt record.
 *
 * @param json - the raw file contents.
 * @param label - a human label for the payload (e.g. `"trace"`) used in the message.
 * @param id - the execution id the payload belongs to, for the error message.
 * @returns the parsed value typed as `T`.
 * @throws {@link PersistenceError} if `json` is not valid JSON.
 */
export function parseStoredJson<T>(json: string, label: string, id: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new PersistenceError(
      `Corrupt persisted ${label} for execution '${id}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * A fully persisted execution as read back from the store: the whole
 * {@link ExecutionRecord} shape (request/response are stored sanitized), plus
 * optional continuation context and plan reference.
 */
export type StoredExecution = ExecutionRecord;

/** The lightweight per-execution row returned by {@link TraceStore.list}. */
export interface StoredSummary {
  /** The execution id. */
  id: string;
  /** The owner key name this execution is filed under. */
  owner: string;
  /** The run's terminal status. */
  status: ExecutionStatus;
  /** Wall-clock start time in ms (the list sort key). */
  started_at: number;
  /** Total wall-clock duration in ms. */
  elapsed_ms: number;
  /** Summed input tokens across all agents. */
  total_input_tokens: number;
  /** Summed output tokens across all agents. */
  total_output_tokens: number;
  /** Summed cache-read tokens across all agents. */
  total_cached_tokens: number;
  /** Summed cache-write tokens across all agents. */
  total_cache_write_tokens: number;
}

/** A page of {@link StoredSummary} rows plus the unpaged total for the owner. */
export interface ListResult {
  /** The summaries on this page, newest first. */
  items: StoredSummary[];
  /** Total matching executions, ignoring paging: the owner's count for
   * {@link TraceStore.list}, the sum across owners (or the filtered owner's
   * count) for {@link TraceStore.listAcrossOwners}. */
  total: number;
}

/**
 * The persistence port for execution traces: insert, look up, list, delete and
 * TTL-prune records, all scoped by owner key name.
 *
 * @remarks The concrete implementation is {@link createJsonTraceStore}.
 */
export interface TraceStore {
  /**
   * Persist a finished execution.
   *
   * @param record - the record to store.
   * @throws a conflict when the record's id already exists for its owner.
   * @remarks Asynchronous because the filesystem implementation lands at the
   *   most expensive moment of a run — a whole trace serialized, then written,
   *   `fsync`ed, renamed and `fsync`ed again. Doing that synchronously stalled
   *   the event loop, which in a process serving several runs at once (the
   *   `@clarvis/server` case) meant every other session stopped with it. The
   *   `await` does not make the work cheaper — `JSON.stringify` and
   *   {@link sanitizeDeep} are still synchronous CPU — it only stops the I/O
   *   from blocking everyone else.
   */
  insert(record: ExecutionRecord): Promise<void>;
  /**
   * Read a full execution by id.
   *
   * @returns the stored execution, or `null` when no such id exists for `owner`.
   */
  getById(owner: string, id: string): StoredExecution | null;
  /** Atomically replace one settled run's continuation snapshot and charge summarizer usage. */
  replaceFinalContext(
    owner: string,
    id: string,
    context: readonly ContextSnapshotEntry[],
    usage?: TokenAccumulator,
  ): Promise<boolean>;
  /**
   * List an owner's executions, newest first, with limit/offset paging.
   *
   * @returns the page of summaries and the owner's total count.
   */
  list(owner: string, limit: number, offset: number): ListResult;
  /**
   * Delete an execution by id.
   *
   * @returns `true` if a record was removed, `false` if none matched.
   */
  deleteById(owner: string, id: string): boolean;
  /**
   * Delete every execution stored for `owner`, plus that owner's lock files.
   *
   * @returns the number of execution records removed.
   * @remarks The erase primitive behind a data-deletion request. Unlike
   *   {@link TraceStore.cleanup} it is scoped to one owner and ignores age, and
   *   unlike deleting id-by-id through {@link TraceStore.list} it never parses a
   *   record body — a trace holds an entire conversation, so reading them all
   *   back to throw them away is not a viable erase path. Filesystem stores keep
   *   this API synchronous by using a non-waiting owner-wide lease; a concurrent
   *   deletion may therefore raise a persistence error for the caller to retry.
   */
  deleteOwner(owner: string): number;
  /**
   * List executions across every owner, newest first, with limit/offset paging.
   *
   * @param limit - maximum rows to return.
   * @param offset - rows to skip.
   * @param filter - `owner` narrows to a single owner, making this equivalent to
   *   {@link TraceStore.list}.
   * @returns the page of summaries and the total matching count.
   * @remarks Optional: a backend that cannot enumerate owners omits it. This is
   *   the **operator** surface — there is deliberately no cross-owner `getById`,
   *   because a trace holds the full conversation. An operator who needs one run
   *   goes through that owner's own scope, which is an explicit, auditable act.
   */
  listAcrossOwners?(limit: number, offset: number, filter?: { owner?: string }): ListResult;
  /** Whether an execution with `id` exists for `owner`. */
  existsForOwner(owner: string, id: string): boolean;
  /**
   * Delete up to `batch` executions started before `cutoffMs` (plus stale
   * temp/lock orphans, and journals older than the same retention cutoff).
   *
   * @returns the number of files removed this call.
   * @remarks A journal is aged on the **retention** cutoff, not the short
   *   temp-orphan grace, and that distinction is load-bearing: the grace is
   *   also what makes a journal *eligible for recovery*, so sweeping on it
   *   would delete precisely the set
   *   {@link TraceStore.recoverOrphans} exists to read — leaving the crash
   *   record silently unrecoverable for any operator who configured a TTL.
   *
   *   `counters`, when supplied, is filled in with the breakdown behind the
   *   returned total. It is an out-parameter rather than a richer return type
   *   because every existing caller and every store double reads a plain count,
   *   and only the retention sweeper's log line needs the split.
   */
  cleanup(
    cutoffMs: number,
    batch: number,
    counters?: TraceCleanupCounters,
    protectedExecutionIds?: ReadonlySet<string>,
  ): number;
  /**
   * Open an append-only journal for a run that is about to start.
   *
   * @param opts - the run's identity and an optional logger; see
   *   {@link OpenJournalOptions}.
   * @returns the journal to append mapped events to.
   * @remarks Optional, like {@link TraceStore.listAcrossOwners}: a backend with
   *   no durable place to stage a partial run omits it, and the run simply
   *   proceeds without crash recovery. It is paired with
   *   {@link TraceStore.recoverOrphans} — a store offering one without the other
   *   would either strand journals or find none.
   *
   *   The store owns the journal's path and tracks it as live, so
   *   {@link TraceStore.recoverOrphans} and {@link TraceStore.cleanup} never
   *   touch a journal whose run is still going. Callers must call
   *   {@link RunJournal.discard} once the record is inserted, or
   *   {@link RunJournal.close} for a run that ended unpersisted.
   */
  openJournal?(opts: OpenJournalOptions): RunJournal;
  /**
   * Fold journals with no matching execution file into `interrupted` records.
   *
   * @returns what the pass saw; see {@link TraceRecoveryReport}.
   * @remarks Idempotent, and safe to call while other runs are live: a journal
   *   this store opened is skipped while it is open, and one younger than the
   *   store's orphan grace is skipped as a cross-process guard. A journal whose
   *   header is unparseable is renamed aside and reported, never deleted - a
   *   trace holds an entire conversation, and tidying a directory is not a
   *   reason to destroy one.
   *
   *   A recovered record carries **no `final_context`**, so `continue_from`
   *   against it still fails. Recovery restores the audit trail and the token
   *   accounting; it does not restore resumability.
   */
  recoverOrphans?(): Promise<TraceRecoveryReport>;
}

/**
 * The breakdown behind {@link TraceStore.cleanup}'s returned total.
 *
 * @remarks Every field counts files the call actually removed or reclaimed, so
 * their sum is the returned total. A caller that does not care passes nothing.
 */
export interface TraceCleanupCounters {
  /** Expired execution records removed (their sidecars are not counted again). */
  records: number;
  /** Orphaned run journals removed on the retention cutoff. */
  journals: number;
  /** Stale `.lock` leases reclaimed. */
  leases: number;
  /** Abandoned atomic-write temp files removed. */
  tmp: number;
}

/**
 * What one {@link TraceStore.recoverOrphans} pass saw.
 *
 * @remarks A bare count could not tell "nothing to recover" from "the budget
 * blew halfway through the scan" — both answered `0` — which is exactly the
 * state an operator most needs named. `exhausted` says a bound stopped the
 * pass, so the journals it did not reach are still on disk for the next boot;
 * `degraded` says a record was recovered but is knowingly incomplete.
 */
export interface TraceRecoveryReport {
  /** Journals folded into `interrupted` execution records. */
  recovered: number;
  /** Orphan journals this pass opened and read. */
  examined: number;
  /** Journals renamed aside for operator inspection instead of recovered. */
  quarantined: number;
  /** Recovered records missing lines or carrying synthesized tool results. */
  degraded: number;
  /** Whether a recovery bound stopped the pass before the tree was walked. */
  exhausted: boolean;
}

/**
 * A {@link TraceStore} that definitely journals - the two optional members made
 * required.
 *
 * @remarks The optionality on {@link TraceStore} is for *consumers*, who must
 * cope with a backend that cannot stage a partial run. A concrete store that
 * does journal advertises it in its return type, so its own callers and tests
 * need no assertion to reach the pair.
 */
export type JournalingTraceStore = TraceStore &
  Required<Pick<TraceStore, "openJournal" | "recoverOrphans">>;

/**
 * Project a full {@link StoredExecution} down to its {@link StoredSummary} row.
 *
 * @param record - the full stored execution.
 * @returns the list-friendly summary (id, status, timing and token totals).
 */
export function recordToSummary(record: StoredExecution): StoredSummary {
  return {
    id: record.id,
    owner: record.owner_key_name,
    status: record.status,
    started_at: record.started_at,
    elapsed_ms: record.elapsed_ms,
    total_input_tokens: record.total_input_tokens,
    total_output_tokens: record.total_output_tokens,
    total_cached_tokens: record.total_cached_tokens,
    total_cache_write_tokens: record.total_cache_write_tokens,
  };
}

/**
 * Sort rows newest-first and return one paged slice, with a stable tiebreak.
 *
 * @param items - the rows to order (not mutated).
 * @param limit - maximum rows to return.
 * @param offset - number of leading rows to skip.
 * @returns the slice `[offset, offset + limit)` sorted by `started_at`
 *   descending, ties broken by descending `id` so ordering is deterministic.
 */
export function sortDescPaginate<T extends { started_at: number; id: string }>(
  items: readonly T[],
  limit: number,
  offset: number,
): T[] {
  const sorted = [...items].sort((a, b) => {
    if (b.started_at !== a.started_at) return b.started_at - a.started_at;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  return sorted.slice(offset, offset + limit);
}
