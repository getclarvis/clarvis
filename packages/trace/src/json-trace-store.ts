import {
  createReadStream,
  mkdirSync,
  chmodSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExecutionRecord, Logger } from "@clarvis/capability";
import {
  executionIdConflict,
  levelEnabled,
  NOOP_LOGGER,
  PersistenceError,
} from "@clarvis/capability";
import {
  acquireLocalLease,
  acquireLocalLeaseSync,
  isTmpFile,
  ownerSegment,
  reclaimLocalLeaseSync,
  writeFileDurable,
  writeFileDurableSync,
} from "@clarvis/paths";
import { sanitizeDeep } from "@clarvis/capability";
import {
  createRunJournal,
  JOURNAL_CORRUPT_SUFFIX,
  JOURNAL_OVERSIZED_SUFFIX,
  JOURNAL_SUFFIX,
  type OpenJournalOptions,
  type RunJournal,
} from "./journal.ts";
import { journalToRecord, parseJournalChunks, writerStillRunning } from "./journal-recovery.ts";
import {
  parseStoredJson,
  recordToSummary,
  sortDescPaginate,
  type JournalingTraceStore,
  type ListResult,
  type StoredExecution,
  type StoredSummary,
  type TraceCleanupCounters,
  type TraceRecoveryReport,
} from "./trace-store.ts";

const FILE_RE = /^(\d+)\.(.+)\.json$/;
/**
 * Extension of the per-record summary sidecar, replacing the record's own
 * `.json`.
 *
 * @remarks Deliberately not a `.json` suffix. {@link FILE_RE}'s `(.+)` is greedy,
 * so a sidecar named `<started_at>.<seg>.summary.json` would parse as a *record*
 * whose id segment is `<seg>.summary` — inflating `total`, entering the owner
 * index, and being read back as a corrupt execution. Ending the name here is
 * what makes that structurally impossible, rather than relying on a guard in
 * {@link parseName} that a later reader has to remember exists. `.seq` is
 * excluded by the same regex for the same reason.
 */
const SUMMARY_SUFFIX = ".summary";
/**
 * How long a `.tmp` staging file must have gone untouched before a sweep treats
 * it as an orphan and reclaims it.
 *
 * @remarks The bound is the longest a *live* write may plausibly have a staging
 * file open, because reclaiming one that is still in use destroys a record being
 * written. Everything else is on the cheap side of the trade: an orphan that
 * survives an extra sweep costs disk, while one collected too early costs a
 * record — and, through {@link executionIdConflict}, makes a wedged lock look
 * permanent. An hour is far past any single atomic write and far short of the
 * retention window the same sweep enforces.
 */
const TMP_ORPHAN_GRACE_MS = 3_600_000;
const LOCKS_DIR = ".locks";
const LOCK_SUFFIX = ".lock";
/**
 * Separates the owner segment from the id segment in a flat lock filename.
 *
 * @remarks Locks are not nested per owner, so `deleteOwner` finds an owner's
 * locks by matching `<ownerSegment><LOCK_KEY_SEP>`. That prefix is unambiguous
 * because {@link ownerSegment} percent-encodes `.` to `%2E` and its overflow form
 * (`h_<sha256>`) is hex — so a segment can never contain this separator, and the
 * first occurrence in a lock filename is always the owner/id boundary.
 */
const LOCK_KEY_SEP = ".";
const DELETE_GENERATION_SUFFIX = ".delete-generation";
const DELETE_LEASE_SUFFIX = ".delete-lease";
const INSERT_GENERATION_SUFFIX = ".insert-generation";
const SEQ_FILE = ".seq";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isMissingDirectory(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

interface ParsedName {
  startedAt: number;
  idSegment: string;
}

interface OwnerGenerationState {
  version: 1;
  state: "active" | "deleting";
  generation: string;
}

function parseName(name: string): ParsedName | null {
  const m = FILE_RE.exec(name);
  if (m === null) return null;
  const startedAt = Number(m[1]);
  if (!Number.isFinite(startedAt)) return null;
  return { startedAt, idSegment: m[2]! };
}

/**
 * The sidecar filename for a record file.
 *
 * @param recordName - a `<started_at>.<segment>.json` execution filename.
 * @returns the same name with {@link SUMMARY_SUFFIX} in place of `.json`.
 */
function summaryName(recordName: string): string {
  return `${recordName.slice(0, -".json".length)}${SUMMARY_SUFFIX}`;
}

/**
 * Parse a journal filename back to the record identity it stands for.
 *
 * @param name - a directory entry name.
 * @returns the started-at and id segment, or `null` when `name` is not a journal.
 * @remarks Journals are invisible to {@link parseName} by construction:
 * {@link FILE_RE} is anchored at `.json$`, and `.jsonl` does not match it. That
 * is the same property {@link SUMMARY_SUFFIX} relies on, and it is why a
 * journal never enters the owner index, `list`, or `getById`.
 */
function parseJournalName(name: string): ParsedName | null {
  if (!name.endsWith(JOURNAL_SUFFIX)) return null;
  return parseName(`${name.slice(0, -JOURNAL_SUFFIX.length)}.json`);
}

/** Options for {@link createJsonTraceStore}. */
export interface JsonTraceStoreOptions {
  /** Root directory the store owns; resolved to an absolute path on open. */
  dir: string;
  /** Test seam after publishing `deleting` and before removing the owner directory. */
  beforeOwnerRemove?: (owner: string) => void;
  /**
   * Test seam after an insert has written the record body and before it
   * re-checks that its owner's generation is still active.
   *
   * @remarks The window between the two is exactly where a concurrent
   *   `deleteOwner` has to be caught, and it is not otherwise addressable: the
   *   record is on disk, the per-id lease is held, and the abort path has not
   *   run yet. A test that instead raced a filesystem watcher against this
   *   window only reproduced the case on a host slow enough to lose the race.
   */
  afterInsertWrite?: (record: ExecutionRecord) => void | Promise<void>;
  /** Maximum per-owner id indexes retained by this store instance; capped at 32. */
  maxOwnerIndexes?: number;
  /** Maximum ids retained in one cached owner index; capped at 50,000. */
  maxOwnerIndexEntries?: number;
  /** Test/embedding seam for entries examined by one cleanup call; capped at 10,000. */
  maxCleanupScanEntries?: number;
  /** Test/embedding seam for root and owner entries examined by journal discovery. */
  maxRecoveryScanEntries?: number;
  /** Maximum UTF-8 bytes admitted for one stored execution; capped at 256 MiB. */
  maxRecordBytes?: number;
  /** Maximum UTF-8 bytes admitted for one summary sidecar; capped at 64 KiB. */
  maxSummaryBytes?: number;
  /**
   * Where the store reports what it could not do; defaults to a no-op.
   *
   * @remarks Nothing here is on a per-entry path. The store's own failures —
   * a refused insert, an unreadable record a listing silently drops, a
   * quarantined journal — are otherwise invisible to everyone, because they are
   * failures of the machinery rather than facts about a run and so have no
   * place in the trace they are about.
   */
  logger?: Logger;
}

export const DEFAULT_MAX_TRACE_OWNER_INDEXES = 32;
export const DEFAULT_MAX_TRACE_OWNER_INDEX_ENTRIES = 50_000;
/** Default maximum UTF-8 size admitted for one stored execution. */
export const DEFAULT_MAX_TRACE_RECORD_BYTES = 128 * 1024 * 1024;
/** Hard maximum UTF-8 size admitted for one stored execution. */
export const MAX_TRACE_RECORD_BYTES = 256 * 1024 * 1024;
/** Hard and default maximum UTF-8 size admitted for one summary sidecar. */
export const MAX_TRACE_SUMMARY_BYTES = 64 * 1024;
/** Largest page a trace listing may materialize in one request. */
export const MAX_TRACE_LIST_LIMIT = 200;
/** Largest offset retained while selecting a trace page. */
export const MAX_TRACE_LIST_OFFSET = 10_000;
const MAX_TRACE_RECOVERY_ENTRIES = 10_000;
/** Maximum root plus owner entries examined by one journal-discovery pass. */
export const MAX_TRACE_RECOVERY_SCAN_ENTRIES = 10_000;
/**
 * At most this many orphan journals are examined in one boot pass.
 *
 * @remarks A **boot** budget, which is what sets its size: recovery runs before
 * the host is useful, so the cost of it being large is startup latency the user
 * cannot skip. Exceeding it is not data loss — the pass records `exhausted` and
 * the untouched journals are re-examined on the next start — so the bound is
 * chosen for how many crashed runs are plausible between two starts, not for how
 * many exist. A host that genuinely accumulated more converges over successive
 * boots instead of paying for all of them once.
 */
export const MAX_TRACE_RECOVERY_JOURNALS = 100;
/** At most this many file bytes are admitted across one recovery pass. */
export const MAX_TRACE_RECOVERY_TOTAL_BYTES = 64 * 1024 * 1024;
/** At most this many bytes are admitted from one journal. */
export const MAX_TRACE_RECOVERY_JOURNAL_BYTES = 32 * 1024 * 1024;
/** At most this many parsed events can be retained for one recovered run. */
export const MAX_TRACE_RECOVERY_EVENTS = 20_000;
/** Maximum directory entries a single synchronous cleanup call examines. */
export const MAX_TRACE_CLEANUP_SCAN_ENTRIES = 10_000;

/**
 * How far {@link createJsonTraceStore}'s `insert` got before it failed.
 *
 * @remarks `generation` is the owner's deleting/active transition, `lease` the
 * exclusive per-id lock and the conflict check under it, and `write` the record
 * body and its generation sidecar.
 */
type TraceInsertPhase = "generation" | "lease" | "write";

interface CleanupCandidate {
  path: string;
  startedAt: number;
  kind: keyof TraceCleanupCounters;
  executionId?: string;
  sidecar?: string;
  generation?: string;
}

interface TraceListRow {
  started_at: number;
  id: string;
}

/** A trace artifact rejected for exceeding its serialized/on-disk byte budget. */
class TraceFileTooLargeError extends PersistenceError {
  constructor(kind: "record" | "summary", path: string, size: number, limit: number) {
    super(`Trace ${kind} '${path}' is ${size} bytes; the limit is ${limit} bytes.`, {
      kind,
      path,
      actual_bytes: size,
      max_bytes: limit,
    });
  }
}

function compareTraceRows(a: TraceListRow, b: TraceListRow): number {
  if (b.started_at !== a.started_at) return b.started_at - a.started_at;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

function normalizeTracePage(limit: number, offset: number): { limit: number; offset: number } {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_TRACE_LIST_LIMIT) {
    throw new PersistenceError(
      `Trace list limit must be an integer between 0 and ${MAX_TRACE_LIST_LIMIT}.`,
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TRACE_LIST_OFFSET) {
    throw new PersistenceError(
      `Trace list offset must be an integer between 0 and ${MAX_TRACE_LIST_OFFSET}.`,
    );
  }
  return { limit, offset };
}

function normalizeCacheLimit(value: number | undefined, hardMaximum: number): number {
  if (value === undefined) return hardMaximum;
  if (!Number.isFinite(value)) return hardMaximum;
  return Math.min(hardMaximum, Math.max(1, Math.floor(value)));
}

function normalizeByteLimit(
  value: number | undefined,
  defaultValue: number,
  hardMaximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value)) return hardMaximum;
  return Math.min(hardMaximum, Math.max(1, Math.floor(value)));
}

function normalizeCleanupBatch(value: number): number {
  if (!Number.isFinite(value)) return MAX_TRACE_RECOVERY_ENTRIES;
  return Math.min(MAX_TRACE_RECOVERY_ENTRIES, Math.max(1, Math.floor(value)));
}

/** Retain the newest `capacity` rows in a worst-first heap. */
function retainNewest<T extends TraceListRow>(heap: T[], row: T, capacity: number): void {
  if (capacity === 0) return;

  const worseThan = (a: T, b: T): boolean => compareTraceRows(a, b) > 0;
  const bubbleUp = (start: number): void => {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!worseThan(heap[index]!, heap[parent]!)) return;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  };
  const sinkRoot = (): void => {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= heap.length) return;
      const right = left + 1;
      let worse = left;
      if (right < heap.length && worseThan(heap[right]!, heap[left]!)) worse = right;
      if (!worseThan(heap[worse]!, heap[index]!)) return;
      [heap[index], heap[worse]] = [heap[worse]!, heap[index]!];
      index = worse;
    }
  };

  if (heap.length < capacity) {
    heap.push(row);
    bubbleUp(heap.length - 1);
    return;
  }
  if (compareTraceRows(row, heap[0]!) >= 0) return;
  heap[0] = row;
  sinkRoot();
}

/**
 * Create a filesystem-backed {@link TraceStore} that persists one JSON file per
 * execution under `<dir>/<owner>/<started_at>.<id>.json`.
 *
 * @param opts - the root directory; see {@link JsonTraceStoreOptions}.
 * @returns a store implementing insert/get/list/delete/exists/cleanup.
 * @remarks Every record is accompanied by a `<started_at>.<id>.summary` sidecar
 *   holding just its {@link StoredSummary}, which is what `list` reads; see
 *   {@link SUMMARY_SUFFIX} for why the name must not end in `.json`, and the
 *   `listOwner` comment for why the full-record fallback is mandatory.
 *
 *   Durability and safety: inserts write to a temp file, `fsync`, then
 *   `rename` into place under an exclusive per-id `.lock` (a crash orphan older
 *   than `TMP_ORPHAN_GRACE_MS` is reclaimed, so a wedged lock cannot masquerade
 *   as a permanent {@link executionIdConflict}); directories are `0700`, files
 *   `0600`. A per-owner id index is cached and invalidated against a small
 *   `.seq` sidecar file's content (see {@link readSeq}/{@link bumpSeq}), not
 *   `mtime` — `mtime` collides too often across rapid successive writes to
 *   trust as a cross-instance freshness guard, and a directory-listing
 *   fingerprint would cost a full `readdirSync` on every call instead of one
 *   small, known-name file read. `request`/`response` are stored through
 *   {@link sanitizeDeep} to strip secrets. `cleanup` also sweeps stale tmp
 *   orphans (recognised via {@link isTmpFile}) and `.lock` orphans, and —
 *   since it deletes execution files directly rather than through
 *   `deleteById` — never bumps the owner(s) it touched onto a fresh `.seq`
 *   token; because `readdirSync(rootDir)` yields
 *   {@link ownerSegment}-encoded directory names rather than the raw owner
 *   keys the in-memory index is keyed by (not cheaply invertible for a hashed
 *   segment), it evicts every cached index outright instead of mis-targeting
 *   one — cheap and infrequent relative to a full cleanup sweep, and correct
 *   regardless of which owners it hit. `deleteOwner` remains synchronous: it
 *   holds a non-waiting local deletion lease while the durable owner state is
 *   `deleting`, removes the directory, and only then publishes `active`. An
 *   insert rejects a live deletion and completes a dead deleter's transaction
 *   before it can publish into that owner's next generation.
 * @throws {@link executionIdConflict} from `insert` when the id already exists
 *   for the owner or a concurrent insert holds the lock.
 */
export function createJsonTraceStore(opts: JsonTraceStoreOptions): JournalingTraceStore {
  const logger = opts.logger ?? NOOP_LOGGER;
  const rootDir = resolve(opts.dir);
  const locksDir = join(rootDir, LOCKS_DIR);
  const maxCleanupScanEntries = normalizeCacheLimit(
    opts.maxCleanupScanEntries,
    MAX_TRACE_CLEANUP_SCAN_ENTRIES,
  );
  const maxRecoveryScanEntries = normalizeCacheLimit(
    opts.maxRecoveryScanEntries,
    MAX_TRACE_RECOVERY_SCAN_ENTRIES,
  );
  const maxRecordBytes = normalizeByteLimit(
    opts.maxRecordBytes,
    DEFAULT_MAX_TRACE_RECORD_BYTES,
    MAX_TRACE_RECORD_BYTES,
  );
  const maxSummaryBytes = normalizeByteLimit(
    opts.maxSummaryBytes,
    MAX_TRACE_SUMMARY_BYTES,
    MAX_TRACE_SUMMARY_BYTES,
  );

  const ownerDir = (owner: string): string => join(rootDir, ownerSegment(owner));
  const lockPathFor = (owner: string, seg: string): string =>
    join(locksDir, `${ownerSegment(owner)}${LOCK_KEY_SEP}${seg}${LOCK_SUFFIX}`);
  const deleteGenerationPathForSegment = (ownerSeg: string): string =>
    join(locksDir, `${ownerSeg}${DELETE_GENERATION_SUFFIX}`);
  const deleteLeasePathForSegment = (ownerSeg: string): string =>
    join(locksDir, `${ownerSeg}${DELETE_LEASE_SUFFIX}`);
  const insertGenerationPathForRecord = (ownerSeg: string, recordName: string): string =>
    join(
      locksDir,
      `${ownerSeg}${LOCK_KEY_SEP}${ownerSegment(recordName)}${INSERT_GENERATION_SUFFIX}`,
    );

  let rootSecured = false;
  const ensureOwnerDir = (owner: string): string => {
    const dir = ownerDir(owner);
    const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!rootSecured) {
      chmodSync(rootDir, 0o700);
      rootSecured = true;
    }
    if (created !== undefined) chmodSync(dir, 0o700);
    return dir;
  };

  const ensureLocksDir = (): void => {
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  };

  const readOptionalFile = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  };

  /** Stat before reading and reject an oversized trace artifact without opening its body. */
  const readBoundedUtf8 = (path: string, kind: "record" | "summary", limit: number): string => {
    const size = statSync(path).size;
    if (size > limit) throw new TraceFileTooLargeError(kind, path, size, limit);
    const raw = readFileSync(path, "utf8");
    const actualBytes = Buffer.byteLength(raw, "utf8");
    if (actualBytes > limit) {
      throw new TraceFileTooLargeError(kind, path, actualBytes, limit);
    }
    return raw;
  };

  const readGenerationState = (ownerSeg: string): OwnerGenerationState => {
    const raw = readOptionalFile(deleteGenerationPathForSegment(ownerSeg));
    if (raw === null) return { version: 1, state: "active", generation: "" };
    try {
      const value = JSON.parse(raw) as Partial<OwnerGenerationState> | null;
      if (
        value !== null &&
        value.version === 1 &&
        (value.state === "active" || value.state === "deleting") &&
        typeof value.generation === "string" &&
        value.generation.length > 0
      ) {
        return { version: 1, state: value.state, generation: value.generation };
      }
    } catch {
      // A pre-state-machine marker is the generation token itself.
    }
    return { version: 1, state: "active", generation: raw };
  };

  const writeGenerationState = (ownerSeg: string, state: OwnerGenerationState): void => {
    writeFileDurableSync(deleteGenerationPathForSegment(ownerSeg), JSON.stringify(state));
  };

  const belongsToGeneration = (
    ownerSeg: string,
    recordName: string,
    generation: string,
  ): boolean => {
    return (
      generation === "" ||
      readOptionalFile(insertGenerationPathForRecord(ownerSeg, recordName)) === generation
    );
  };

  const belongsToCurrentGeneration = (ownerSeg: string, recordName: string): boolean => {
    const state = readGenerationState(ownerSeg);
    return state.state === "active" && belongsToGeneration(ownerSeg, recordName, state.generation);
  };

  const isActiveGeneration = (ownerSeg: string, generation: string): boolean => {
    const state = readGenerationState(ownerSeg);
    return state.state === "active" && state.generation === generation;
  };

  function* readDirEntries(dir: string, budget?: { remaining: number }): Generator<string> {
    let handle;
    try {
      handle = opendirSync(dir);
    } catch (err) {
      if (isMissingDirectory(err)) return;
      throw err;
    }
    try {
      for (;;) {
        if (budget !== undefined && budget.remaining <= 0) return;
        const entry = handle.readSync();
        if (entry === null) return;
        if (budget !== undefined) budget.remaining -= 1;
        yield entry.name;
      }
    } catch (err) {
      // Bun may defer scandir errors until the first read from a Dir handle.
      if (!isMissingDirectory(err)) throw err;
    } finally {
      try {
        handle.closeSync();
      } catch {
        // Closing a directory removed concurrently is best effort.
      }
    }
  }

  interface OwnerIndex {
    byId: Map<string, string>;
    seq: string;
    generationState: string;
    complete: boolean;
  }
  const indexByOwner = new Map<string, OwnerIndex>();
  const maxOwnerIndexes = normalizeCacheLimit(
    opts.maxOwnerIndexes,
    DEFAULT_MAX_TRACE_OWNER_INDEXES,
  );
  const maxOwnerIndexEntries = normalizeCacheLimit(
    opts.maxOwnerIndexEntries,
    DEFAULT_MAX_TRACE_OWNER_INDEX_ENTRIES,
  );

  /**
   * Report an owner index this store stopped being able to answer from memory.
   *
   * @param owner - the owner whose index was dropped or capped.
   * @param reason - `lru` when another owner displaced it, `entry_cap` when the
   *   owner has more ids than one index may retain.
   * @remarks Level-guarded because both arms repeat once the store is past a
   *   ceiling: the next lookup falls back to a streaming directory scan, which
   *   stays correct and gets slower, and that is precisely the shape of slowdown
   *   nobody can otherwise explain.
   */
  const logOwnerIndexEvicted = (owner: string, reason: "lru" | "entry_cap"): void => {
    if (!levelEnabled(logger, "debug")) return;
    logger.debug(
      { event: "trace.owner_index_evicted", owner_key_name: owner, reason },
      "an owner's cached id index was dropped; later lookups for it fall back to a directory scan",
    );
  };

  const cacheOwnerIndex = (owner: string, index: OwnerIndex): OwnerIndex => {
    indexByOwner.delete(owner);
    indexByOwner.set(owner, index);
    while (indexByOwner.size > maxOwnerIndexes) {
      const oldest = indexByOwner.keys().next().value;
      if (oldest === undefined) break;
      indexByOwner.delete(oldest);
      logOwnerIndexEvicted(oldest, "lru");
    }
    return index;
  };

  /**
   * Reads an owner directory's change-sequence token: a small sidecar file
   * rewritten to a fresh random value by every {@link insert}/`deleteById`,
   * used instead of directory `mtime` to detect an external change cheaply.
   *
   * @remarks `mtime` alone is not a safe freshness guard here: measured on this
   *   store's own directories, a rapid insert-then-delete (or any two mutations
   *   close enough in time) collides on the identical reported `mtimeMs` far
   *   too often to trust — a long-lived reader would then keep serving a
   *   stale, since-deleted entry. A directory-listing fingerprint would be
   *   equally safe but costs a full `readdirSync` (and re-sort) on *every*
   *   call, including the common no-change case; reading one small, known-name
   *   file is `O(1)` regardless of how many executions the owner has
   *   accumulated. `""` (never written, e.g. a brand-new owner directory)
   *   naturally compares unequal to any real token.
   */
  const seqPath = (dir: string): string => join(dir, SEQ_FILE);
  const readSeq = (dir: string): string => {
    try {
      return readFileSync(seqPath(dir), "utf8");
    } catch (err) {
      if (isEnoent(err)) return "";
      throw err;
    }
  };
  const bumpSeq = (dir: string): string => {
    const token = randomUUID();
    writeFileSync(seqPath(dir), token, { mode: 0o600 });
    return token;
  };

  const ownerIndex = (owner: string): OwnerIndex => {
    const dir = ownerDir(owner);
    const ownerSeg = ownerSegment(owner);
    const generationState = readGenerationState(ownerSeg);
    const generationStateKey = `${generationState.state}:${generationState.generation}`;
    const seq = readSeq(dir);
    const cached = indexByOwner.get(owner);
    if (
      cached !== undefined &&
      cached.seq === seq &&
      cached.generationState === generationStateKey
    ) {
      return cacheOwnerIndex(owner, cached);
    }
    const byId = new Map<string, string>();
    let complete = true;
    if (generationState.state === "active") {
      for (const name of readDirEntries(dir)) {
        const meta = parseName(name);
        if (meta !== null && belongsToGeneration(ownerSeg, name, generationState.generation)) {
          if (byId.size >= maxOwnerIndexEntries) {
            complete = false;
            break;
          }
          byId.set(meta.idSegment, name);
        }
      }
    }
    const idx: OwnerIndex = { byId, seq, generationState: generationStateKey, complete };
    return cacheOwnerIndex(owner, idx);
  };

  const findEntry = (owner: string, id: string): string | undefined => {
    const seg = ownerSegment(id);
    const index = ownerIndex(owner);
    const cached = index.byId.get(seg);
    if (cached !== undefined || index.complete) return cached;
    const ownerSeg = ownerSegment(owner);
    const generation = readGenerationState(ownerSeg);
    if (generation.state !== "active") return undefined;
    for (const name of readDirEntries(ownerDir(owner))) {
      const meta = parseName(name);
      if (meta?.idSegment === seg && belongsToGeneration(ownerSeg, name, generation.generation)) {
        return name;
      }
    }
    return undefined;
  };

  /** Delete a path, ignoring every failure including its absence. */
  const unlinkQuietly = (p: string): void => {
    try {
      unlinkSync(p);
    } catch {
      void 0;
    }
  };

  /** Remove machinery that can only belong to generations being deleted. */
  const purgeOwnerMachinery = (ownerSeg: string): void => {
    const prefix = `${ownerSeg}${LOCK_KEY_SEP}`;
    for (const name of readDirEntries(locksDir)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(locksDir, name);
      if (name.endsWith(LOCK_SUFFIX)) {
        reclaimLocalLeaseSync(path, { staleMs: 0 });
      } else if (name.endsWith(INSERT_GENERATION_SUFFIX)) {
        unlinkQuietly(path);
      }
    }
  };

  const deletionInProgress = (owner: string): PersistenceError =>
    new PersistenceError(`Trace owner '${owner}' deletion is in progress.`);

  /**
   * Return an active generation, completing a deletion whose process crashed.
   *
   * The deletion lease is acquired before `deleting` is published and held
   * through the owner-directory purge. Consequently a missing/reclaimable lease
   * beside `deleting` is proof that this caller may finish that transaction.
   */
  const ensureActiveGeneration = async (owner: string, ownerSeg: string): Promise<string> => {
    const observed = readGenerationState(ownerSeg);
    if (observed.state === "active") return observed.generation;

    const lease = await acquireLocalLease(deleteLeasePathForSegment(ownerSeg), {
      staleMs: 0,
      waitMs: 0,
    });
    if (lease === null) {
      const latest = readGenerationState(ownerSeg);
      if (latest.state === "active") return latest.generation;
      throw deletionInProgress(owner);
    }

    try {
      await lease.assertOwned();
      const latest = readGenerationState(ownerSeg);
      if (latest.state === "active") return latest.generation;

      rmSync(ownerDir(owner), { recursive: true, force: true });
      indexByOwner.delete(owner);
      purgeOwnerMachinery(ownerSeg);
      writeGenerationState(ownerSeg, {
        version: 1,
        state: "active",
        generation: latest.generation,
      });
      return latest.generation;
    } finally {
      await lease.release();
    }
  };

  /**
   * Write the list-sized projection of a record beside it.
   *
   * @remarks Written **after** the record's `rename` and with no `fsync`, on
   *   purpose: the sidecar is derived data, so losing it to a crash costs a
   *   slower `list` and nothing else, while a sidecar that outlived its record
   *   would be a phantom row. Every failure is swallowed for the same reason —
   *   an execution that persisted must not be reported as failed because an
   *   optimization could not be written.
   */
  const writeSummarySidecar = async (
    owner: string,
    dir: string,
    filename: string,
    summary: StoredSummary,
  ): Promise<void> => {
    const lost = (cause: string): void => {
      logger.debug(
        { event: "trace.sidecar_write_failed", owner_key_name: owner, filename, cause },
        "a listing sidecar was not written; every later listing reads that row's whole record instead",
      );
    };
    try {
      const serialized = JSON.stringify(summary);
      if (Buffer.byteLength(serialized, "utf8") > maxSummaryBytes) {
        lost(`summary exceeds ${String(maxSummaryBytes)} bytes`);
        return;
      }
      await fsp.writeFile(join(dir, summaryName(filename)), serialized, {
        mode: 0o600,
      });
    } catch (err) {
      lost(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Read a record's summary sidecar.
   *
   * @returns the stored summary, or `null` when the sidecar is missing (a record
   *   written before sidecars existed, or one whose sidecar was lost) or
   *   unparsable or oversized — in every case the caller falls back to the
   *   bounded full-record reader.
   */
  const readSummarySidecar = (dir: string, filename: string): StoredSummary | null => {
    try {
      const path = join(dir, summaryName(filename));
      return JSON.parse(readBoundedUtf8(path, "summary", maxSummaryBytes)) as StoredSummary;
    } catch {
      return null;
    }
  };

  /**
   * Delete a record's summary sidecar, if it has one.
   *
   * @remarks Silent on every error, including a missing file: the sidecar is an
   *   optimization, and failing a deletion over one would be worse than leaving
   *   a stale 200-byte file that the next `list` ignores anyway.
   */
  const removeSummarySidecar = (dir: string, filename: string): void => {
    unlinkQuietly(join(dir, summaryName(filename)));
  };

  const insertLocked = async (
    record: ExecutionRecord,
    dir: string,
    seg: string,
  ): Promise<string> => {
    const stored: StoredExecution = {
      id: record.id,
      owner_key_name: record.owner_key_name,
      status: record.status,
      started_at: record.started_at,
      ended_at: record.ended_at,
      elapsed_ms: record.elapsed_ms,
      request: sanitizeDeep(record.request),
      response: sanitizeDeep(record.response),
      trace: record.trace,
      total_input_tokens: record.total_input_tokens,
      total_output_tokens: record.total_output_tokens,
      total_cached_tokens: record.total_cached_tokens,
      total_cache_write_tokens: record.total_cache_write_tokens,
      ...(record.final_context !== undefined ? { final_context: record.final_context } : {}),
      ...(record.capability_state !== undefined
        ? { capability_state: record.capability_state }
        : {}),
      ...(record.recovery !== undefined ? { recovery: record.recovery } : {}),
    };
    const filename = `${record.started_at}.${seg}.json`;
    const finalPath = join(dir, filename);
    const serialized = JSON.stringify(stored);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > maxRecordBytes) {
      throw new TraceFileTooLargeError("record", finalPath, serializedBytes, maxRecordBytes);
    }
    await writeFileDurable(finalPath, serialized);
    await writeSummarySidecar(record.owner_key_name, dir, filename, recordToSummary(stored));
    return filename;
  };

  /**
   * Shared body of `list`, factored out so `listAcrossOwners` can call it
   * directly instead of through `this` — a plain reference to a method
   * extracted off the returned store object (`const { listAcrossOwners } =
   * store`) would otherwise call it with `this` `undefined` and throw.
   *
   * Each row is served from its summary sidecar when one exists, and only falls
   * back to reading and parsing the whole record when it does not. That fallback
   * is not optional: records written before sidecars existed have none, and
   * requiring one would turn an optimization into a breaking change. It is also
   * the entire point of the sidecar — the full record carries the run's whole
   * conversation, and a page of twenty multi-megabyte traces used to be read and
   * `JSON.parse`d in full to produce nine scalars apiece.
   */
  /**
   * Report a stored record a listing had to leave out of its page.
   *
   * @param ownerKeyName - the owner the row belongs to; the on-disk owner
   *   segment for the cross-owner listing, which never sees the raw key.
   * @param id - the record's filename, which carries its id segment.
   * @param reason - `corrupt` for a body that would not parse, `too_large` for
   *   one past the admission limit.
   * @param path - where the unreadable file is.
   * @remarks The row is dropped from `items` while `total` still counts it, so
   * without this the page simply under-returns and nothing says why.
   */
  const logRecordUnreadable = (
    ownerKeyName: string,
    id: string,
    reason: "corrupt" | "too_large",
    path: string,
  ): void => {
    logger.warn(
      { event: "trace.record_unreadable", owner_key_name: ownerKeyName, id, reason, path },
      "a stored execution could not be read; it is omitted from the listing while the total still counts it",
    );
  };

  const listOwner = (owner: string, limit: number, offset: number): ListResult => {
    const normalized = normalizeTracePage(limit, offset);
    const pageSize = normalized.limit === 0 ? 0 : normalized.limit + normalized.offset;
    const rows: { started_at: number; id: string }[] = [];
    let total = 0;
    const ownerSeg = ownerSegment(owner);
    const generation = readGenerationState(ownerSeg);
    if (generation.state !== "active") return { items: [], total: 0 };
    for (const name of readDirEntries(ownerDir(owner))) {
      const meta = parseName(name);
      if (meta === null || !belongsToGeneration(ownerSeg, name, generation.generation)) continue;
      total += 1;
      retainNewest(rows, { started_at: meta.startedAt, id: name }, pageSize);
    }
    const page = sortDescPaginate(rows, normalized.limit, normalized.offset);
    const items: StoredSummary[] = [];
    const dir = ownerDir(owner);
    for (const row of page) {
      const sidecar = readSummarySidecar(dir, row.id);
      if (sidecar !== null) {
        items.push(sidecar);
        continue;
      }
      const path = join(dir, row.id);
      let raw: string;
      try {
        raw = readBoundedUtf8(path, "record", maxRecordBytes);
      } catch (err) {
        if (err instanceof TraceFileTooLargeError) {
          logRecordUnreadable(owner, row.id, "too_large", path);
          continue;
        }
        if (isEnoent(err)) continue;
        throw err;
      }
      try {
        items.push(recordToSummary(parseStoredJson<StoredExecution>(raw, "trace", row.id)));
      } catch {
        logRecordUnreadable(owner, row.id, "corrupt", path);
        continue;
      }
    }
    return { items, total };
  };

  const liveJournals = new Set<string>();

  /**
   * Yield one value per examined directory entry, carrying a deletion candidate
   * only when that entry is expired.
   *
   * @remarks Yielding `null` is load-bearing: the caller can stop after a fixed
   * number of *examined* entries even when none are expired. The generator then
   * retains at most the root and current owner directory handles and resumes at
   * the same cursor on the next cleanup interval instead of rescanning an
   * unbounded history synchronously from the beginning.
   */
  function* cleanupEntries(
    cutoffMs: number,
    tmpOrphanCutoff: number,
  ): Generator<CleanupCandidate | null> {
    for (const ownerName of readDirEntries(rootDir)) {
      const dir = join(rootDir, ownerName);
      yield null;
      if (ownerName === LOCKS_DIR) {
        for (const name of readDirEntries(dir)) {
          let candidate: CleanupCandidate | null = null;
          if (name.endsWith(LOCK_SUFFIX)) {
            const path = join(dir, name);
            try {
              const mtimeMs = statSync(path).mtimeMs;
              if (mtimeMs < tmpOrphanCutoff) {
                candidate = { path, startedAt: mtimeMs, kind: "leases" };
              }
            } catch {
              // A concurrent owner operation already handled this entry.
            }
          }
          yield candidate;
        }
        continue;
      }
      for (const name of readDirEntries(dir)) {
        let candidate: CleanupCandidate | null = null;
        const meta = parseName(name);
        if (meta !== null) {
          if (meta.startedAt < cutoffMs) {
            candidate = {
              path: join(dir, name),
              startedAt: meta.startedAt,
              kind: "records",
              executionId: meta.idSegment,
              sidecar: join(dir, summaryName(name)),
              generation: insertGenerationPathForRecord(ownerName, name),
            };
          }
          yield candidate;
          continue;
        }
        const journalMeta = parseJournalName(name);
        if (journalMeta !== null) {
          if (
            !liveJournals.has(`${ownerName}/${journalMeta.idSegment}`) &&
            journalMeta.startedAt < cutoffMs
          ) {
            candidate = {
              path: join(dir, name),
              startedAt: journalMeta.startedAt,
              kind: "journals",
            };
          }
          yield candidate;
          continue;
        }
        if (isTmpFile(name)) {
          const path = join(dir, name);
          try {
            const mtimeMs = statSync(path).mtimeMs;
            if (mtimeMs < tmpOrphanCutoff) candidate = { path, startedAt: mtimeMs, kind: "tmp" };
          } catch {
            // A concurrent atomic writer already renamed or removed it.
          }
        }
        yield candidate;
      }
    }
  }

  let cleanupScan: Generator<CleanupCandidate | null> | null = null;

  const store: JournalingTraceStore = {
    openJournal(opts: OpenJournalOptions): RunJournal {
      const { header } = opts;
      const seg = ownerSegment(header.id);
      const dir = ensureOwnerDir(header.owner_key_name);
      const path = join(dir, `${header.started_at}.${seg}${JOURNAL_SUFFIX}`);
      const key = `${ownerSegment(header.owner_key_name)}/${seg}`;
      liveJournals.add(key);
      const inner = createRunJournal({
        path,
        header,
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      });
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        liveJournals.delete(key);
      };
      return {
        append: (event) => {
          inner.append(event);
        },
        discard: () => {
          inner.discard();
          release();
        },
        close: () => {
          inner.close();
          release();
        },
      };
    },

    async recoverOrphans(): Promise<TraceRecoveryReport> {
      const staleCutoff = Date.now() - TMP_ORPHAN_GRACE_MS;
      let recovered = 0;
      let examined = 0;
      let quarantined = 0;
      let degraded = 0;
      let admittedBytes = 0;
      let exhausted = false;
      const scanBudget = { remaining: maxRecoveryScanEntries };
      /**
       * Report the bound that stopped this pass, once.
       *
       * @param limit - which budget ran out.
       * @remarks Every arm breaks out of both loops immediately after calling
       * this, so a pass emits at most one such line.
       */
      const exhaust = (limit: "journals" | "scan_entries" | "total_bytes"): void => {
        exhausted = true;
        logger.warn(
          {
            event: "trace.recovery_budget_exhausted",
            examined,
            recovered,
            admitted_bytes: admittedBytes,
            limit,
          },
          "crash recovery stopped on a budget; the journals it did not reach stay on disk for the next start",
        );
      };
      /**
       * Rename a journal aside and report where it went.
       *
       * @param path - the journal being quarantined.
       * @param suffix - the extension replacing `.jsonl`.
       * @param reason - why it is not being recovered.
       * @param size - the journal's size on disk.
       * @remarks A rename that fails is the interesting case: the journal is
       * then re-examined on every boot, spending part of the pass's budget
       * forever, and nothing else would say so.
       */
      const quarantine = (
        path: string,
        suffix: string,
        reason: "bad_header" | "limit" | "oversized",
        size: number,
      ): void => {
        let renamed = true;
        try {
          renameSync(path, `${path.slice(0, -JOURNAL_SUFFIX.length)}${suffix}`);
        } catch {
          renamed = false;
        }
        quarantined += 1;
        logger.warn(
          {
            event: "trace.journal_quarantined",
            path,
            reason,
            size_bytes: size,
            renamed,
          },
          renamed
            ? "a journal was set aside for inspection instead of recovered; its run is not in the trace list"
            : "a journal could not be set aside; it stays in place and is re-examined on every start",
        );
      };
      for (const ownerName of readDirEntries(rootDir, scanBudget)) {
        if (exhausted) break;
        const remainingJournals = MAX_TRACE_RECOVERY_JOURNALS - examined;
        if (remainingJournals <= 0) {
          exhaust("journals");
          break;
        }
        if (ownerName === LOCKS_DIR) continue;
        if (readGenerationState(ownerName).state === "deleting") continue;
        const dir = join(rootDir, ownerName);
        const journals: { name: string; seg: string }[] = [];
        const recordSegments = new Set<string>();
        for (const name of readDirEntries(dir, scanBudget)) {
          const jm = parseJournalName(name);
          if (jm !== null) {
            if (journals.length < remainingJournals) {
              journals.push({ name, seg: jm.idSegment });
            }
            continue;
          }
          const meta = parseName(name);
          if (meta !== null && belongsToCurrentGeneration(ownerName, name)) {
            recordSegments.add(meta.idSegment);
          }
        }
        if (scanBudget.remaining <= 0) {
          // The directory may have an unseen record matching a discovered
          // journal. Leave the owner untouched rather than making insertion's
          // conflict check perform an unbounded fallback scan.
          exhaust("scan_entries");
          continue;
        }
        for (const { name, seg } of journals) {
          if (examined >= MAX_TRACE_RECOVERY_JOURNALS) {
            exhaust("journals");
            break;
          }
          if (recordSegments.has(seg)) continue;
          if (liveJournals.has(`${ownerName}/${seg}`)) continue;
          const path = join(dir, name);
          let mtimeMs: number;
          let size: number;
          try {
            const stat = statSync(path);
            mtimeMs = stat.mtimeMs;
            size = stat.size;
          } catch {
            continue;
          }
          if (mtimeMs >= staleCutoff) continue;
          examined += 1;
          if (size > MAX_TRACE_RECOVERY_JOURNAL_BYTES) {
            quarantine(path, JOURNAL_OVERSIZED_SUFFIX, "oversized", size);
            continue;
          }
          if (admittedBytes + size > MAX_TRACE_RECOVERY_TOTAL_BYTES) {
            exhaust("total_bytes");
            break;
          }
          admittedBytes += size;
          let parsed;
          try {
            const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
            parsed = await parseJournalChunks(stream as AsyncIterable<string>, {
              maxChars: MAX_TRACE_RECOVERY_JOURNAL_BYTES,
              maxLineChars: MAX_TRACE_RECOVERY_JOURNAL_BYTES,
              maxEvents: MAX_TRACE_RECOVERY_EVENTS,
            });
          } catch {
            continue;
          }
          if (parsed.ok && writerStillRunning(parsed.header)) continue;
          if (!parsed.ok) {
            const limited = parsed.reason === "limit";
            quarantine(
              path,
              limited ? JOURNAL_OVERSIZED_SUFFIX : JOURNAL_CORRUPT_SUFFIX,
              limited ? "limit" : "bad_header",
              size,
            );
            continue;
          }
          const record = journalToRecord(parsed);
          try {
            await store.insert(record);
            recovered += 1;
          } catch {
            continue;
          }
          const recovery = record.recovery;
          if (recovery !== undefined) {
            degraded += 1;
            logger.warn(
              {
                event: "trace.journal_recovery_degraded",
                execution_id: record.id,
                skipped_lines: recovery.skipped_lines,
                synthesized_tool_calls: recovery.synthesized_tool_calls,
                events: record.trace.events.length,
              },
              "a run was recovered from a damaged journal; its trace is missing lines or carries synthesized tool results",
            );
          }
          unlinkQuietly(path);
        }
      }
      const report: TraceRecoveryReport = {
        recovered,
        examined,
        quarantined,
        degraded,
        exhausted,
      };
      logger.info(
        { event: "trace.recovery_completed", ...report },
        "crash recovery finished; recovered runs are listed as interrupted and cannot be continued",
      );
      return report;
    },

    async insert(record): Promise<void> {
      const owner = record.owner_key_name;
      const ownerSeg = ownerSegment(owner);
      let phase: TraceInsertPhase = "generation";
      try {
        ensureLocksDir();
        const generation = await ensureActiveGeneration(owner, ownerSeg);
        phase = "lease";
        const dir = ensureOwnerDir(owner);
        const seg = ownerSegment(record.id);
        if (findEntry(owner, record.id) !== undefined) {
          throw executionIdConflict(record.id);
        }
        const lockPath = lockPathFor(owner, seg);
        const lease = await acquireLocalLease(lockPath, {
          staleMs: TMP_ORPHAN_GRACE_MS,
          waitMs: 0,
        });
        if (lease === null) throw executionIdConflict(record.id);
        try {
          await lease.assertOwned();
          const idx = ownerIndex(owner);
          if (findEntry(owner, record.id) !== undefined) {
            throw executionIdConflict(record.id);
          }
          phase = "write";
          const filename = await insertLocked(record, dir, seg);
          const abortDeletedInsert = (): never => {
            unlinkQuietly(join(dir, filename));
            removeSummarySidecar(dir, filename);
            unlinkQuietly(insertGenerationPathForRecord(ownerSeg, filename));
            phase = "generation";
            logger.warn(
              {
                event: "trace.insert_aborted_deleted_owner",
                execution_id: record.id,
                owner_key_name: owner,
                generation,
              },
              "the owner was deleted while this execution was being written; the partial record was rolled back",
            );
            throw new PersistenceError(
              `Trace owner '${owner}' was deleted while execution '${record.id}' was being persisted.`,
            );
          };
          await opts.afterInsertWrite?.(record);
          if (!isActiveGeneration(ownerSeg, generation)) abortDeletedInsert();
          if (generation !== "") {
            await writeFileDurable(insertGenerationPathForRecord(ownerSeg, filename), generation);
          }
          if (!isActiveGeneration(ownerSeg, generation)) abortDeletedInsert();
          if (idx.byId.size < maxOwnerIndexEntries) idx.byId.set(seg, filename);
          else {
            idx.complete = false;
            logOwnerIndexEvicted(owner, "entry_cap");
          }
          idx.seq = bumpSeq(dir);
        } finally {
          await lease.release();
        }
      } catch (err) {
        logger.error(
          {
            event: "trace.insert_failed",
            execution_id: record.id,
            owner_key_name: owner,
            phase,
            cause: err instanceof Error ? err.message : String(err),
          },
          "an execution record was not persisted; the run's trace is lost unless its journal is recovered",
        );
        throw err;
      }
    },

    getById(owner, id): StoredExecution | null {
      const match = findEntry(owner, id);
      if (match === undefined) return null;
      let raw: string;
      try {
        raw = readBoundedUtf8(join(ownerDir(owner), match), "record", maxRecordBytes);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
      return parseStoredJson<StoredExecution>(raw, "trace", id);
    },

    async replaceFinalContext(owner, id, context, usage): Promise<boolean> {
      ensureLocksDir();
      const ownerSeg = ownerSegment(owner);
      await ensureActiveGeneration(owner, ownerSeg);
      const deletionLease = await acquireLocalLease(deleteLeasePathForSegment(ownerSeg), {
        staleMs: 0,
        waitMs: 0,
      });
      if (deletionLease === null) throw deletionInProgress(owner);
      const seg = ownerSegment(id);
      const lease = await acquireLocalLease(lockPathFor(owner, seg), {
        staleMs: TMP_ORPHAN_GRACE_MS,
        waitMs: 0,
      });
      if (lease === null) {
        await deletionLease.release();
        throw new PersistenceError(`Execution '${id}' is busy.`);
      }
      try {
        await deletionLease.assertOwned();
        await lease.assertOwned();
        const match = findEntry(owner, id);
        if (match === undefined) return false;
        const dir = ownerDir(owner);
        const path = join(dir, match);
        const stored = parseStoredJson<StoredExecution>(
          readBoundedUtf8(path, "record", maxRecordBytes),
          "trace",
          id,
        );
        stored.final_context = [...context];
        stored.total_input_tokens += usage?.input ?? 0;
        stored.total_output_tokens += usage?.output ?? 0;
        stored.total_cached_tokens += usage?.cached ?? 0;
        stored.total_cache_write_tokens += usage?.cache_write ?? 0;
        const serialized = JSON.stringify(stored);
        const serializedBytes = Buffer.byteLength(serialized, "utf8");
        if (serializedBytes > maxRecordBytes) {
          throw new TraceFileTooLargeError("record", path, serializedBytes, maxRecordBytes);
        }
        await writeFileDurable(path, serialized);
        await writeSummarySidecar(owner, dir, match, recordToSummary(stored));
        return true;
      } finally {
        await lease.release();
        await deletionLease.release();
      }
    },

    existsForOwner(owner, id): boolean {
      return findEntry(owner, id) !== undefined;
    },

    list: listOwner,

    deleteById(owner, id): boolean {
      ensureLocksDir();
      const ownerSeg = ownerSegment(owner);
      const deletionLease = acquireLocalLeaseSync(deleteLeasePathForSegment(ownerSeg), {
        staleMs: 0,
      });
      if (deletionLease === null) throw deletionInProgress(owner);
      const seg = ownerSegment(id);
      const lease = acquireLocalLeaseSync(lockPathFor(owner, seg), {
        staleMs: TMP_ORPHAN_GRACE_MS,
      });
      if (lease === null) {
        deletionLease.release();
        throw new PersistenceError(`Execution '${id}' is busy.`);
      }
      try {
        const generation = readGenerationState(ownerSeg);
        if (generation.state !== "active") throw deletionInProgress(owner);
        const match = findEntry(owner, id);
        if (match === undefined) return false;
        try {
          unlinkSync(join(ownerDir(owner), match));
        } catch (err) {
          if (isEnoent(err)) return false;
          throw err;
        }
        removeSummarySidecar(ownerDir(owner), match);
        unlinkQuietly(insertGenerationPathForRecord(ownerSeg, match));
        const idx = indexByOwner.get(owner);
        if (idx !== undefined) {
          idx.byId.delete(seg);
          idx.seq = bumpSeq(ownerDir(owner));
        }
        return true;
      } finally {
        lease.release();
        deletionLease.release();
      }
    },

    deleteOwner(owner): number {
      ensureLocksDir();
      const ownerSeg = ownerSegment(owner);
      const lease = acquireLocalLeaseSync(deleteLeasePathForSegment(ownerSeg), { staleMs: 0 });
      if (lease === null) throw deletionInProgress(owner);

      try {
        const previous = readGenerationState(ownerSeg);
        const nextGeneration = randomUUID();
        writeGenerationState(ownerSeg, {
          version: 1,
          state: "deleting",
          generation: nextGeneration,
        });

        const dir = ownerDir(owner);
        let removed = 0;
        if (previous.state === "active") {
          for (const name of readDirEntries(dir)) {
            const meta = parseName(name);
            if (meta !== null && belongsToGeneration(ownerSeg, name, previous.generation)) {
              removed += 1;
            }
          }
        }

        opts.beforeOwnerRemove?.(owner);
        rmSync(dir, { recursive: true, force: true });
        indexByOwner.delete(owner);
        purgeOwnerMachinery(ownerSeg);
        writeGenerationState(ownerSeg, {
          version: 1,
          state: "active",
          generation: nextGeneration,
        });
        return removed;
      } finally {
        lease.release();
      }
    },

    listAcrossOwners(limit, offset, filter): ListResult {
      if (filter?.owner !== undefined) return listOwner(filter.owner, limit, offset);
      const normalized = normalizeTracePage(limit, offset);
      const pageSize = normalized.limit === 0 ? 0 : normalized.limit + normalized.offset;
      const rows: {
        started_at: number;
        id: string;
        dir: string;
        name: string;
        owner: string;
      }[] = [];
      let total = 0;
      for (const ownerName of readDirEntries(rootDir)) {
        if (ownerName === LOCKS_DIR) continue;
        const dir = join(rootDir, ownerName);
        for (const name of readDirEntries(dir)) {
          const meta = parseName(name);
          if (meta !== null && belongsToCurrentGeneration(ownerName, name)) {
            total += 1;
            retainNewest(
              rows,
              { started_at: meta.startedAt, id: name, dir, name, owner: ownerName },
              pageSize,
            );
          }
        }
      }
      const page = sortDescPaginate(rows, normalized.limit, normalized.offset);
      const items: StoredSummary[] = [];
      for (const row of page) {
        const sidecar = readSummarySidecar(row.dir, row.name);
        if (sidecar !== null) {
          items.push(sidecar);
          continue;
        }
        const path = join(row.dir, row.name);
        let raw: string;
        try {
          raw = readBoundedUtf8(path, "record", maxRecordBytes);
        } catch (err) {
          if (err instanceof TraceFileTooLargeError) {
            logRecordUnreadable(row.owner, row.name, "too_large", path);
            continue;
          }
          if (isEnoent(err)) continue;
          throw err;
        }
        try {
          items.push(recordToSummary(parseStoredJson<StoredExecution>(raw, "execution", row.id)));
        } catch {
          logRecordUnreadable(row.owner, row.name, "corrupt", path);
          continue;
        }
      }
      return { items, total };
    },

    cleanup(cutoffMs, batch, counters, protectedExecutionIds): number {
      const cleanupBatch = normalizeCleanupBatch(batch);
      const tmpOrphanCutoff = Date.now() - TMP_ORPHAN_GRACE_MS;
      const protectedExecutionSegments =
        protectedExecutionIds === undefined
          ? undefined
          : new Set([...protectedExecutionIds].map((id) => ownerSegment(id)));
      const expired: CleanupCandidate[] = [];
      const newerThan = (a: (typeof expired)[number], b: (typeof expired)[number]): boolean =>
        a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.path > b.path);
      const sinkExpiredRoot = (): void => {
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          if (left >= expired.length) return;
          const right = left + 1;
          let newer = left;
          if (right < expired.length && newerThan(expired[right]!, expired[left]!)) newer = right;
          if (!newerThan(expired[newer]!, expired[index]!)) return;
          [expired[index], expired[newer]] = [expired[newer]!, expired[index]!];
          index = newer;
        }
      };
      const retainExpired = (entry: (typeof expired)[number]): void => {
        if (expired.length < cleanupBatch) {
          expired.push(entry);
          let index = expired.length - 1;
          while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (!newerThan(expired[index]!, expired[parent]!)) break;
            [expired[index], expired[parent]] = [expired[parent]!, expired[index]!];
            index = parent;
          }
          return;
        }
        if (!newerThan(expired[0]!, entry)) return;
        expired[0] = entry;
        sinkExpiredRoot();
      };
      cleanupScan ??= cleanupEntries(cutoffMs, tmpOrphanCutoff);
      let scanned = 0;
      while (scanned < maxCleanupScanEntries) {
        const next = cleanupScan.next();
        if (next.done === true) {
          cleanupScan = null;
          break;
        }
        scanned += 1;
        if (
          next.value !== null &&
          (next.value.executionId === undefined ||
            !protectedExecutionSegments?.has(next.value.executionId))
        ) {
          retainExpired(next.value);
        }
      }
      expired.sort((a, b) => a.startedAt - b.startedAt);
      let deleted = 0;
      const count = (kind: keyof TraceCleanupCounters): void => {
        deleted += 1;
        if (counters !== undefined) counters[kind] += 1;
      };
      for (const e of expired) {
        if (deleted >= cleanupBatch) break;
        if (e.kind === "leases") {
          if (reclaimLocalLeaseSync(e.path, { staleMs: TMP_ORPHAN_GRACE_MS })) count("leases");
          continue;
        }
        try {
          unlinkSync(e.path);
          count(e.kind);
        } catch (err) {
          if (isEnoent(err)) continue;
          throw err;
        }
        if (e.sidecar !== undefined) unlinkQuietly(e.sidecar);
        if (e.generation !== undefined) unlinkQuietly(e.generation);
      }
      if (deleted > 0) indexByOwner.clear();
      return deleted;
    },
  };

  return store;
}
