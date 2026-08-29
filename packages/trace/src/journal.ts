import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import type { RunRequest } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { sanitizeDeep } from "@clarvis/capability";

/**
 * Journal format version, stamped on every header line and bumped whenever the
 * shape of a line changes.
 */
export const JOURNAL_VERSION = 1;

/** Filename extension of a run journal, chosen so it cannot be read as a record. */
export const JOURNAL_SUFFIX = ".jsonl";

/**
 * Extension a journal is renamed to when its header cannot be parsed.
 *
 * @remarks A trace holds an entire conversation, so an unreadable journal is
 * quarantined rather than deleted - tidying a directory is not a reason to
 * destroy the only surviving copy of a run.
 */
export const JOURNAL_CORRUPT_SUFFIX = ".jsonl.corrupt";

/** Extension used when recovery refuses a journal that exceeds a safety bound. */
export const JOURNAL_OVERSIZED_SUFFIX = ".jsonl.oversized";

/**
 * The first line of every journal: enough to rebuild an execution record's
 * identity and request without any other source.
 *
 * @remarks `request` is stored through {@link sanitizeDeep}, matching what
 * {@link import("./json-trace-store.ts").createJsonTraceStore | the store} does
 * at insert time, so a recovered record's request field is byte-equivalent
 * to the one a normal run would have persisted.
 */
export interface JournalHeader {
  /** {@link JOURNAL_VERSION} at the time the journal was opened. */
  v: number;
  /** The execution id this journal belongs to. */
  id: string;
  /** The owner key name the eventual record is filed under. */
  owner_key_name: string;
  /** Absolute wall-clock start of the run, in milliseconds. */
  started_at: number;
  /** The originating run request, sanitized. */
  request: RunRequest;
  /** Opaque host snapshot captured at run start. */
  host_metadata?: Record<string, unknown>;
  /**
   * The process that opened the journal, and the host it ran on.
   *
   * @remarks Recovery's in-process live-set only knows about journals *this*
   * process opened, and a journal's mtime only advances when an event is
   * appended — so a run parked on a human elicitation for longer than the
   * orphan grace looks abandoned to a sibling process sharing the trace dir.
   * Recovering it would fold a live run into an `interrupted` record and delete
   * its journal, and the real run would then fail to persist at all with an id
   * conflict. Recording the owner lets a peer on the same host ask whether the
   * process is still alive before deciding.
   */
  writer?: { pid: number; host: string };
}

/**
 * The write side of one run's journal: append mapped events as they are
 * recorded, then discard the file once the run's record is durably inserted.
 *
 * @remarks Every method is infallible by contract. A write error marks the
 *   journal dead and is reported through the logger exactly once; every
 *   subsequent call is a no-op. A run must never fail because its journal did -
 *   the journal is a best-effort improvement over losing the run entirely, not
 *   a new way to lose it.
 */
export interface RunJournal {
  /**
   * Append one mapped event.
   *
   * @param event - the mapped event, or `null` for an entry with no persistable
   *   projection; `null` is ignored, matching
   *   {@link import("./trace-mapper.ts").mapTrace | mapTrace}.
   */
  append(event: TraceEvent | null): void;
  /** Delete the journal, called once the run's record is durably inserted. */
  discard(): void;
  /** Close the descriptor without deleting, for a run that ended unpersisted. */
  close(): void;
}

/**
 * What a caller hands {@link import("./trace-store.ts").TraceStore.openJournal | openJournal}.
 *
 * @remarks The store owns the path - it is the only component that knows the
 * directory layout - so a caller supplies just the identity and the logger.
 */
export interface OpenJournalOptions {
  /** The header written as the journal's first line, before any event. */
  header: Omit<JournalHeader, "v">;
  /** Optional logger; a journal failure is reported here exactly once. */
  logger?: Logger;
}

/** Inputs to {@link createRunJournal}. */
export interface CreateRunJournalOptions {
  /** Absolute path of the `.jsonl` file to create. */
  path: string;
  /** The header written as the journal's first line, before any event. */
  header: Omit<JournalHeader, "v">;
  /** Optional logger; a journal failure is reported here exactly once. */
  logger?: Logger;
}

/**
 * Open a run journal and write its header line.
 *
 * @param opts - the target path, the header to stamp, and an optional logger.
 * @returns a {@link RunJournal}; one whose every method is a no-op when the file
 *   could not be opened.
 * @remarks The file is created with `"ax"` (exclusive). An id collision is
 *   already impossible by the store's own reservation, so an `EEXIST` here is a
 *   bug detector rather than a race guard.
 *
 *   Lines are written with `writeSync` and are deliberately **not** `fsync`ed.
 *   The failure this guards against is *process* death - a segfault, an
 *   uncaught fatal, a `SIGKILL` - and data handed to `write(2)` survives all
 *   three, because it sits in the kernel's page cache rather than the dying
 *   process's heap. `fsync` would buy survival of *machine* death instead, a
 *   different and far rarer failure, at the price of a disk round-trip per
 *   trace event on a path that emits one per tool call and per iteration.
 */
export function createRunJournal(opts: CreateRunJournalOptions): RunJournal {
  const { path, header, logger } = opts;
  let fd: number | null = null;
  let dead = false;

  const die = (err: unknown, phase: string): void => {
    if (dead) return;
    dead = true;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
    logger?.warn(
      { path, phase, cause: err instanceof Error ? err.message : String(err) },
      "run journal disabled; the run continues without a crash-recoverable trace",
    );
  };

  try {
    fd = openSync(path, "ax", 0o600);
    const line: JournalHeader = {
      v: JOURNAL_VERSION,
      id: header.id,
      owner_key_name: header.owner_key_name,
      started_at: header.started_at,
      request: sanitizeDeep(header.request),
      ...(header.host_metadata === undefined
        ? {}
        : { host_metadata: sanitizeDeep(header.host_metadata) }),
      writer: { pid: process.pid, host: hostname() },
    };
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } catch (err) {
    die(err, "open");
  }

  return {
    append(event: TraceEvent | null): void {
      if (dead || fd === null || event === null) return;
      try {
        writeSync(fd, `${JSON.stringify(event)}\n`);
      } catch (err) {
        die(err, "append");
      }
    },
    discard(): void {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
      dead = true;
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    },
    close(): void {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
      dead = true;
    },
  };
}
