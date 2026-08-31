import { opendirSync, readFileSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import type {
  CursorPage,
  CursorPagination,
  Session,
  SessionService,
  SessionSummary,
} from "@clarvis/protocol";
import { globalPaths, ownerSegment, writeFileAtomicSync } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

/** Narrow an arbitrary parsed value to a {@link Session} by shape, guarding against corrupt or foreign JSON on disk. */
function isSession(v: unknown): v is Session {
  const s = v as Session | null;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.project_id === "string" &&
    typeof s.workspace === "string" &&
    typeof s.created_at === "number" &&
    Array.isArray(s.turns) &&
    s.turns.every((turn) => turn?.kind === "conversation" || turn?.kind === "transcript") &&
    s.totals !== null &&
    typeof s.totals === "object"
  );
}

const SESSION_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_SUMMARY_MAX_BYTES = 8 * 1024;
const SESSION_PAGE_DEFAULT = 50;
const SESSION_PAGE_MAX = 200;
const LEGACY_LIST_MAX = 200;
const LEGACY_LIST_MAX_BYTES = 32 * 1024 * 1024;
const CURSOR_MAX_BYTES = 256;
const JSON_MAX_DEPTH = 128;
/** Maximum number of catalog files read before yielding to other kernel/TUI work. */
const SESSION_SCAN_BATCH = 64;
/** Maximum estimated file bytes inspected in one event-loop slice. */
const SESSION_SCAN_BATCH_BYTES = 512 * 1024;
const SESSION_REFERENCE_SCAN_MAX_FILES = 10_000;
const SESSION_REFERENCE_SCAN_MAX_BYTES = 256 * 1024 * 1024;

/** Result of scanning durable sessions for trace-retention references. */
export interface SessionExecutionReferences {
  ids: ReadonlySet<string>;
  /** False when a safety bound or filesystem failure prevented a complete scan. */
  complete: boolean;
}

interface SessionReferenceScanLimits {
  maxFiles?: number;
  maxBytes?: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Collect execution ids retained by valid persisted sessions across all owners.
 *
 * @param dir - Clarvis global root containing the session store.
 * @returns The collected ids plus whether every eligible session was inspected.
 */
export function referencedSessionExecutionIds(
  dir: string,
  limits: SessionReferenceScanLimits = {},
): SessionExecutionReferences {
  const ids = new Set<string>();
  const maxFiles = limits.maxFiles ?? SESSION_REFERENCE_SCAN_MAX_FILES;
  const maxBytes = limits.maxBytes ?? SESSION_REFERENCE_SCAN_MAX_BYTES;
  const sessionsRoot = globalPaths(dir).sessionsDir;
  let owners: ReturnType<typeof opendirSync>;
  try {
    owners = opendirSync(sessionsRoot);
  } catch (error) {
    return { ids, complete: isMissing(error) };
  }
  let scanned = 0;
  let bytes = 0;
  let complete = true;
  try {
    for (;;) {
      let owner: Dirent | null;
      try {
        owner = owners.readSync();
      } catch (error) {
        if (!isMissing(error)) complete = false;
        break;
      }
      if (owner === null) break;
      if (scanned >= maxFiles) return { ids, complete: false };
      if (!owner.isDirectory()) continue;
      let files: ReturnType<typeof opendirSync>;
      try {
        files = opendirSync(join(sessionsRoot, owner.name));
      } catch (error) {
        if (!isMissing(error)) complete = false;
        continue;
      }
      try {
        for (;;) {
          let entry: Dirent | null;
          try {
            entry = files.readSync();
          } catch (error) {
            if (!isMissing(error)) complete = false;
            break;
          }
          if (entry === null) break;
          if (scanned >= maxFiles) return { ids, complete: false };
          if (
            !entry.isFile() ||
            !entry.name.endsWith(".json") ||
            entry.name.endsWith(".summary.json")
          ) {
            continue;
          }
          scanned += 1;
          const path = join(sessionsRoot, owner.name, entry.name);
          let contents: string;
          try {
            const size = statSync(path).size;
            if (size > SESSION_MAX_BYTES) continue;
            if (bytes + size > maxBytes) return { ids, complete: false };
            bytes += size;
            contents = readFileSync(path, "utf8");
          } catch (error) {
            if (!isMissing(error)) complete = false;
            continue;
          }
          let session: unknown;
          try {
            session = JSON.parse(contents) as unknown;
          } catch {
            continue;
          }
          if (!isSession(session)) continue;
          for (const turn of session.turns) {
            if (typeof turn.execution_id === "string") ids.add(turn.execution_id);
          }
        }
      } finally {
        try {
          files.closeSync();
        } catch (error) {
          if (!isMissing(error)) complete = false;
        }
      }
    }
  } finally {
    try {
      owners.closeSync();
    } catch (error) {
      if (!isMissing(error)) complete = false;
    }
  }
  return { ids, complete };
}

function jsonStringBytes(value: string): number {
  let bytes = 2; // surrounding quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Preflight JSON size without materializing the encoded document.
 *
 * @remarks This is intentionally conservative at unsupported/custom JSON
 * boundaries. The session DTO is plain JSON; refusing a `toJSON` object or an
 * excessively deep graph prevents a caller from using serialization itself as
 * the allocation spike that bypasses the persisted-size cap.
 */
function jsonFits(value: unknown, limit: number): boolean {
  let bytes = 0;
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes <= limit;
  };
  const visit = (current: unknown, depth: number, arrayValue = false): boolean => {
    if (depth > JSON_MAX_DEPTH) return false;
    if (current === null) return add(4);
    switch (typeof current) {
      case "string":
        return add(jsonStringBytes(current));
      case "number":
        return add(Number.isFinite(current) ? String(current).length : 4);
      case "boolean":
        return add(current ? 4 : 5);
      case "undefined":
      case "function":
      case "symbol":
        return arrayValue ? add(4) : true;
      case "bigint":
        return false;
      case "object":
        break;
    }

    const object = current as Record<string, unknown>;
    if (typeof object.toJSON === "function") return false;
    if (Array.isArray(current)) {
      if (!add(2)) return false;
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !add(1)) return false;
        if (!visit(current[index], depth + 1, true)) return false;
      }
      return true;
    }

    if (!add(2)) return false;
    let first = true;
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      const member = object[key];
      if (["undefined", "function", "symbol"].includes(typeof member)) continue;
      if (!first && !add(1)) return false;
      first = false;
      if (!add(jsonStringBytes(key) + 1) || !visit(member, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function serializeBounded(value: unknown, limit: number, message: string): string {
  if (!jsonFits(value, limit)) throw kernelError("resource_exhausted", message);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw kernelError("resource_exhausted", message);
  }
  return serialized;
}

function toSummary(session: Session): SessionSummary {
  const last = session.turns.at(-1);
  return {
    id: session.id,
    title: session.title,
    project_id: session.project_id,
    workspace: session.workspace,
    created_at: session.created_at,
    updated_at: session.updated_at,
    ...(session.profile === undefined ? {} : { profile: session.profile }),
    turn_count: session.turns.length,
    ...(last === undefined ? {} : { last_status: last.status }),
    ...(last?.environment === undefined ? {} : { last_environment: last.environment }),
    totals: session.totals,
  };
}

function isSummary(value: unknown): value is SessionSummary {
  const summary = value as SessionSummary | null;
  return (
    summary !== null &&
    typeof summary === "object" &&
    typeof summary.id === "string" &&
    typeof summary.title === "string" &&
    typeof summary.project_id === "string" &&
    typeof summary.workspace === "string" &&
    typeof summary.created_at === "number" &&
    typeof summary.updated_at === "number" &&
    typeof summary.turn_count === "number" &&
    summary.totals !== null &&
    typeof summary.totals === "object"
  );
}

function compareSummaries(left: SessionSummary, right: SessionSummary): number {
  return right.updated_at - left.updated_at || right.id.localeCompare(left.id);
}

/**
 * Retain a bounded top-K in a worst-first heap.
 *
 * The worst retained row stays at index zero, so a catalog entry is admitted
 * or rejected in O(log page size), with one final page-sized sort after the
 * directory scan.
 */
export function retainSessionSummary(
  heap: SessionSummary[],
  summary: SessionSummary,
  capacity: number,
): void {
  const bubbleUp = (from: number): void => {
    let index = from;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const value = heap[index];
      const parentValue = heap[parent];
      if (
        value === undefined ||
        parentValue === undefined ||
        compareSummaries(value, parentValue) <= 0
      ) {
        return;
      }
      heap[index] = parentValue;
      heap[parent] = value;
      index = parent;
    }
  };
  const sinkWorst = (): void => {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      const worstValue = heap[worst];
      const leftValue = heap[left];
      if (
        leftValue !== undefined &&
        worstValue !== undefined &&
        compareSummaries(leftValue, worstValue) > 0
      ) {
        worst = left;
      }
      const candidateWorst = heap[worst];
      const rightValue = heap[right];
      if (
        rightValue !== undefined &&
        candidateWorst !== undefined &&
        compareSummaries(rightValue, candidateWorst) > 0
      ) {
        worst = right;
      }
      if (worst === index) return;
      const value = heap[index];
      const replacement = heap[worst];
      if (value === undefined || replacement === undefined) return;
      heap[index] = replacement;
      heap[worst] = value;
      index = worst;
    }
  };

  if (heap.length < capacity) {
    heap.push(summary);
    bubbleUp(heap.length - 1);
    return;
  }
  const worst = heap[0];
  if (worst === undefined || compareSummaries(summary, worst) >= 0) return;
  heap[0] = summary;
  sinkWorst();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertScanActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw kernelError("cancelled", "session catalog request was cancelled");
  }
}

interface SessionPageScanOptions {
  /** Transport-owned cancellation; never serialized into the page DTO. */
  signal?: AbortSignal;
}

interface FileSessionService extends SessionService {
  listPage(
    page?: CursorPagination,
    scan?: SessionPageScanOptions,
  ): Promise<CursorPage<SessionSummary>>;
}

interface SummaryRead {
  summary: SessionSummary | null;
  inspectedBytes: number;
}

interface SessionCursor {
  updatedAt: number;
  id: string;
}

function encodeCursor(summary: SessionSummary): string {
  return Buffer.from(JSON.stringify([summary.updated_at, summary.id]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): SessionCursor | undefined {
  if (cursor === undefined) return undefined;
  if (Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES) {
    throw kernelError("invalid_request", "session cursor exceeds 256 bytes");
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "number" ||
      !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      parsed[1].length === 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    throw kernelError("invalid_request", "invalid session cursor");
  }
}

function afterCursor(summary: SessionSummary, cursor: SessionCursor | undefined): boolean {
  if (cursor === undefined) return true;
  return (
    summary.updated_at < cursor.updatedAt ||
    (summary.updated_at === cursor.updatedAt && summary.id.localeCompare(cursor.id) < 0)
  );
}

/**
 * Build a file-backed {@link SessionService} storing one JSON session per id under
 * `dir/sessions/<owner>/`.
 *
 * @param opts - `dir` (the containing root) and `owner` (the scope whose sessions
 *   this serves). Both segments are {@link segment}-encoded, hashing long values
 *   to stay within filesystem name limits.
 * @returns a {@link SessionService} whose reads are tolerant — a missing dir lists
 *   empty, and unreadable/corrupt/foreign-shaped files are skipped rather than
 *   thrown — and whose saves are atomic (tmp + `rename`).
 */
export function createSessionService(opts: {
  dir: string;
  owner: string;
  projectId: string;
  workspaceId: string;
  /** Where a session restore is reported. */
  logger?: Logger;
}): FileSessionService {
  const logger = opts.logger ?? NOOP_LOGGER;
  const ownerDir = join(globalPaths(opts.dir).sessionsDir, ownerSegment(opts.owner));

  /** Absolute path of the session file for `id` (segment-encoded, `.json` suffix). */
  function fileFor(id: string): string {
    return join(ownerDir, `${ownerSegment(id)}.json`);
  }

  function summaryFor(id: string): string {
    return join(ownerDir, `${ownerSegment(id)}.summary.json`);
  }

  /** Read and validate one session file; `null` on any read/parse error or a non-{@link Session} shape. */
  function readOne(path: string): Session | null {
    try {
      if (statSync(path).size > SESSION_MAX_BYTES) return null;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isSession(parsed) &&
        parsed.project_id === opts.projectId &&
        parsed.workspace === opts.workspaceId
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function serializeSummary(summary: SessionSummary): string {
    return serializeBounded(summary, SESSION_SUMMARY_MAX_BYTES, "session summary exceeds 8 KiB");
  }

  function readSummary(sessionPath: string, entry: string): SummaryRead {
    const sidecar = join(ownerDir, `${entry.slice(0, -5)}.summary.json`);
    let inspectedBytes = 0;
    try {
      const sidecarBytes = statSync(sidecar).size;
      inspectedBytes += sidecarBytes;
      if (sidecarBytes > SESSION_SUMMARY_MAX_BYTES) {
        throw new Error("oversized session summary");
      }
      const value = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
      if (
        isSummary(value) &&
        value.project_id === opts.projectId &&
        value.workspace === opts.workspaceId
      ) {
        return { summary: value, inspectedBytes };
      }
    } catch {}
    try {
      inspectedBytes += statSync(sessionPath).size;
    } catch {}
    const session = readOne(sessionPath);
    if (session === null) return { summary: null, inspectedBytes };
    const summary = toSummary(session);
    let serialized: string;
    try {
      // A legacy full record predates the bounded sidecar contract. Do not
      // return an unbounded projection merely because repairing its sidecar is
      // opportunistic: the page itself has the same 8 KiB retention budget.
      serialized = serializeSummary(summary);
    } catch {
      return { summary: null, inspectedBytes };
    }
    try {
      writeFileAtomicSync(summaryFor(summary.id), serialized);
    } catch {
      // The bounded catalog remains readable when an opportunistic legacy
      // sidecar cannot be repaired (for example, on a read-only filesystem).
    }
    return { summary, inspectedBytes };
  }

  function sessionEntries(): Iterable<string> {
    return {
      *[Symbol.iterator]() {
        let dir: ReturnType<typeof opendirSync>;
        try {
          dir = opendirSync(ownerDir);
        } catch {
          return;
        }
        try {
          for (;;) {
            let entry: Dirent | null;
            try {
              entry = dir.readSync();
            } catch {
              return;
            }
            if (entry === null) return;
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith(".json") || entry.name.endsWith(".summary.json")) continue;
            yield entry.name;
          }
        } finally {
          dir.closeSync();
        }
      },
    };
  }

  return {
    async listPage(
      page: CursorPagination = {},
      scan: SessionPageScanOptions = {},
    ): Promise<CursorPage<SessionSummary>> {
      const limit = page.limit ?? SESSION_PAGE_DEFAULT;
      if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_PAGE_MAX) {
        throw kernelError("invalid_request", "session page limit must be between 1 and 200");
      }
      const cursor = decodeCursor(page.cursor);
      const selected: SessionSummary[] = [];
      let scanned = 0;
      let scannedBytes = 0;
      assertScanActive(scan.signal);
      for (const entry of sessionEntries()) {
        assertScanActive(scan.signal);
        const read = readSummary(join(ownerDir, entry), entry);
        if (read.summary !== null && afterCursor(read.summary, cursor)) {
          retainSessionSummary(selected, read.summary, limit + 1);
        }
        scanned += 1;
        scannedBytes += read.inspectedBytes;
        if (scanned % SESSION_SCAN_BATCH === 0 || scannedBytes >= SESSION_SCAN_BATCH_BYTES) {
          await yieldToEventLoop();
          assertScanActive(scan.signal);
          scannedBytes = 0;
        }
      }
      selected.sort(compareSummaries);
      const hasMore = selected.length > limit;
      const items = selected.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        ...(hasMore && last !== undefined ? { next_cursor: encodeCursor(last) } : {}),
      };
    },

    /**
     * List the owner's sessions, most-recently-updated first.
     *
     * @returns every readable, valid session; empty when the owner dir is missing.
     *   Corrupt or non-session files are silently skipped.
     */
    async list(): Promise<Session[]> {
      const out: Session[] = [];
      let retainedBytes = 0;
      let scanned = 0;
      let scannedBytes = 0;
      for (const entry of sessionEntries()) {
        if (out.length >= LEGACY_LIST_MAX) {
          throw kernelError(
            "resource_exhausted",
            "session list exceeds 200 full records; use listPage()",
          );
        }
        let bytes: number;
        try {
          bytes = statSync(join(ownerDir, entry)).size;
        } catch {
          continue;
        }
        if (retainedBytes + bytes > LEGACY_LIST_MAX_BYTES) {
          throw kernelError(
            "resource_exhausted",
            "session list exceeds 32 MiB of full records; use listPage()",
          );
        }
        const s = readOne(join(ownerDir, entry));
        if (s) {
          out.push(s);
          retainedBytes += bytes;
        }
        scanned += 1;
        scannedBytes += bytes;
        if (scanned % SESSION_SCAN_BATCH === 0 || scannedBytes >= SESSION_SCAN_BATCH_BYTES) {
          await yieldToEventLoop();
          scannedBytes = 0;
        }
      }
      return out.sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
    },

    /**
     * Fetch a single session by id.
     *
     * @param id - the session id.
     * @returns the session, or `null` when it is absent, unreadable, or malformed.
     */
    async get(id: string): Promise<Session | null> {
      const session = readOne(fileFor(id));
      logger.debug(
        {
          event: "sessions.rehydrate",
          session_id: id,
          found: session !== null,
          turns: session?.turns.length ?? 0,
          pending: session?.pending?.length ?? 0,
        },
        "a session document was restored; a session that reads back as absent was unreadable or belongs to another workspace",
      );
      return session;
    },

    /**
     * Persist a session, creating the owner dir as needed.
     *
     * @param session - the session to write; keyed by its `id`.
     * @remarks The write is atomic (tmp + `rename`), so a concurrent reader sees
     *   the old file or the complete new one, never a partial.
     */
    async save(session: Session): Promise<void> {
      if (session.project_id !== opts.projectId || session.workspace !== opts.workspaceId) {
        throw kernelError(
          "invalid_request",
          "session project/workspace does not match the connected kernel",
        );
      }
      const serialized = serializeBounded(
        session,
        SESSION_MAX_BYTES,
        "session document exceeds 8 MiB",
      );
      const summary = toSummary(session);
      const serializedSummary = serializeSummary(summary);
      // Invalidate the old sidecar before publishing a replacement document.
      // A crash anywhere after this point can only leave a missing sidecar,
      // which listPage rebuilds from the authoritative full record, never a
      // valid-looking but permanently stale summary.
      try {
        unlinkSync(summaryFor(session.id));
      } catch {}
      writeFileAtomicSync(fileFor(session.id), serialized);
      writeFileAtomicSync(summaryFor(session.id), serializedSummary);
    },

    /**
     * Delete a session by id.
     *
     * @param id - the session id.
     * @returns `true` if a file was removed, `false` if it was already gone (or
     *   could not be unlinked).
     */
    async delete(id: string): Promise<boolean> {
      try {
        unlinkSync(summaryFor(id));
      } catch {
        // Legacy records have no summary sidecar.
      }
      try {
        unlinkSync(fileFor(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}
