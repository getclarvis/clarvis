import { Buffer } from "node:buffer";
import { opendirSync, readFileSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { globalPaths, ownerSegment, writeFileAtomicSync } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";

/** One node of a workflow tree as persisted: the manager (root) or a leader. */
export interface WorkflowEdge {
  run_id: string;
  parent_run_id?: string;
  kind: "manager" | "leader";
  profile?: string;
  title: string;
  /** Full leader instruction; absent on the manager and legacy records. */
  task?: string;
  round_id?: string;
  pass?: number;
  item_index?: number;
  replica?: number;
  replica_count?: number;
  error?: { code: string; message: string };
  reason?: string;
  status: string;
  started_at?: number;
  ended_at?: number;
}

/** Latest durable manager decision point for an authored round sequence. */
export interface WorkflowSequenceRecord {
  session_id: string;
  status: "running_round" | "awaiting_manager" | "completed" | "stopped" | "failed" | "cancelled";
  revision: number;
  round_id?: string;
  pass?: number;
  next_round_id?: string;
  next_pass?: number;
  leaders_started: number;
  max_total_leaders: number;
  reason?: string;
}

/**
 * The persisted record of one workflow: its identity, the manager status, the tree
 * edges (manager + leaders), and a rolled-up token total. Deliberately NOT the run
 * traces — each `run_id` is its own {@link import("@clarvis/loop").StoredExecution}
 * in the trace store, reachable through the run service.
 */
export interface WorkflowRecord {
  id: string;
  root_run_id: string;
  title: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
  edges: WorkflowEdge[];
  /** Latest checkpoint; absent on legacy records and workflows using only ad-hoc leaders. */
  sequence?: WorkflowSequenceRecord;
  /**
   * Output tokens spent across the whole tree, as the workflow ledger counted
   * them.
   *
   * @remarks Output only, and named for it. This replaced a
   * `{ input, output, cached }` triple whose other two members no member of the
   * pipeline ever wrote: the ledger is an output-token ceiling, and the run
   * events the service observes carry no usage at all — so a reader saw
   * `input: 0` beside a manager that had just consumed 361k input tokens and
   * had no way to know the field was structurally dead rather than true.
   */
  output_tokens: number;
}

/** Compact persisted/list projection that never retains the workflow edge bodies. */
export interface WorkflowRecordSummary {
  id: string;
  title: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
  leader_count: number;
}

export interface WorkflowRecordPage {
  items: WorkflowRecordSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface WorkflowPageRequest {
  limit?: number;
  offset?: number;
}

/** Transport-owned cancellation for a potentially large catalog scan. */
export interface WorkflowPageScanOptions {
  signal?: AbortSignal;
}

/** Synchronous record operations plus an optimized, yielding summary page. */
export interface WorkflowStore {
  save(record: WorkflowRecord): void;
  get(id: string): WorkflowRecord | null;
  /** Legacy full-body listing. It is retained for API compatibility but bounded. */
  list(): WorkflowRecord[];
  /** File stores implement the summary-sidecar path; custom legacy stores may omit it. */
  listPage?(
    page?: WorkflowPageRequest,
    scan?: WorkflowPageScanOptions,
  ): Promise<WorkflowRecordPage>;
  delete(id: string): boolean;
}

/** The standard file store always exposes optimized summary pagination. */
export interface FileWorkflowStore extends WorkflowStore {
  listPage(page?: WorkflowPageRequest, scan?: WorkflowPageScanOptions): Promise<WorkflowRecordPage>;
}

/** Marker appended whenever persistence deliberately shortens authored/model text. */
export const WORKFLOW_TRUNCATION_MARKER = "[truncated by Clarvis: workflow persistence limit]";
/** Manager plus leader edges retained in one workflow record. */
export const WORKFLOW_MAX_EDGES = 256;
export const WORKFLOW_MAX_TASK_BYTES = 16 * 1024;
export const WORKFLOW_MAX_ERROR_BYTES = 4 * 1024;
export const WORKFLOW_MAX_REASON_BYTES = 4 * 1024;
export const WORKFLOW_MAX_TITLE_BYTES = 1024;
const WORKFLOW_MAX_SEQUENCE_ID_BYTES = 1024;
export const WORKFLOW_RECORD_MAX_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_PAGE_DEFAULT = 20;
const WORKFLOW_PAGE_MAX = 200;
const WORKFLOW_PAGE_MAX_OFFSET = 2_000;
export const WORKFLOW_PERSIST_DELAY_MS = 50;

const WORKFLOW_SUMMARY_MAX_BYTES = 8 * 1024;
const LEGACY_LIST_MAX = 200;
const LEGACY_LIST_MAX_BYTES = 32 * 1024 * 1024;
const WORKFLOW_SCAN_BATCH = 64;
const WORKFLOW_SCAN_BATCH_BYTES = 512 * 1024;

/** Bound one UTF-8 string and leave an explicit, user-visible persistence marker. */
export function truncateWorkflowText(value: string, maxBytes: number, field: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = `\n${WORKFLOW_TRUNCATION_MARKER} ${field}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maxBytes) return suffix.slice(0, maxBytes);
  const budget = maxBytes - suffixBytes;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/** Canonical bounded edge used by both live observation and file-store writes. */
export function boundedWorkflowEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    run_id: edge.run_id,
    ...(edge.parent_run_id === undefined ? {} : { parent_run_id: edge.parent_run_id }),
    kind: edge.kind,
    ...(edge.profile === undefined ? {} : { profile: edge.profile }),
    title: truncateWorkflowText(edge.title, WORKFLOW_MAX_TITLE_BYTES, "title"),
    ...(edge.task === undefined
      ? {}
      : { task: truncateWorkflowText(edge.task, WORKFLOW_MAX_TASK_BYTES, "task") }),
    ...(edge.round_id === undefined ? {} : { round_id: edge.round_id }),
    ...(edge.pass === undefined ? {} : { pass: edge.pass }),
    ...(edge.item_index === undefined ? {} : { item_index: edge.item_index }),
    ...(edge.replica === undefined ? {} : { replica: edge.replica }),
    ...(edge.replica_count === undefined ? {} : { replica_count: edge.replica_count }),
    ...(edge.error === undefined
      ? {}
      : {
          error: {
            code: truncateWorkflowText(edge.error.code, 256, "error code"),
            message: truncateWorkflowText(
              edge.error.message,
              WORKFLOW_MAX_ERROR_BYTES,
              "error message",
            ),
          },
        }),
    ...(edge.reason === undefined
      ? {}
      : { reason: truncateWorkflowText(edge.reason, WORKFLOW_MAX_REASON_BYTES, "reason") }),
    status: edge.status,
    ...(edge.started_at === undefined ? {} : { started_at: edge.started_at }),
    ...(edge.ended_at === undefined ? {} : { ended_at: edge.ended_at }),
  };
}

/** Canonical bounded checkpoint used by live observation and file writes. */
export function boundedWorkflowSequence(sequence: WorkflowSequenceRecord): WorkflowSequenceRecord {
  return {
    session_id: truncateWorkflowText(
      sequence.session_id,
      WORKFLOW_MAX_SEQUENCE_ID_BYTES,
      "sequence id",
    ),
    status: sequence.status,
    revision: sequence.revision,
    ...(sequence.round_id === undefined
      ? {}
      : { round_id: truncateWorkflowText(sequence.round_id, 1024, "round id") }),
    ...(sequence.pass === undefined ? {} : { pass: sequence.pass }),
    ...(sequence.next_round_id === undefined
      ? {}
      : { next_round_id: truncateWorkflowText(sequence.next_round_id, 1024, "next round id") }),
    ...(sequence.next_pass === undefined ? {} : { next_pass: sequence.next_pass }),
    leaders_started: sequence.leaders_started,
    max_total_leaders: sequence.max_total_leaders,
    ...(sequence.reason === undefined
      ? {}
      : {
          reason: truncateWorkflowText(
            sequence.reason,
            WORKFLOW_MAX_REASON_BYTES,
            "sequence reason",
          ),
        }),
  };
}

/** Mark the manager edge when additional leaders cannot fit the bounded tree. */
export function markWorkflowEdgesTruncated(record: WorkflowRecord): void {
  const root = record.edges.find((edge) => edge.kind === "manager");
  if (root === undefined || root.reason?.includes(WORKFLOW_TRUNCATION_MARKER) === true) return;
  const notice = `${WORKFLOW_TRUNCATION_MARKER} additional leader edges omitted after ${String(WORKFLOW_MAX_EDGES)} nodes`;
  root.reason = truncateWorkflowText(
    root.reason === undefined ? notice : `${root.reason}\n${notice}`,
    WORKFLOW_MAX_REASON_BYTES,
    "reason",
  );
}

/** Produce the canonical bounded document written to disk. */
function boundedWorkflowRecord(record: WorkflowRecord): WorkflowRecord {
  const bounded: WorkflowRecord = {
    id: record.id,
    root_run_id: record.root_run_id,
    title: truncateWorkflowText(record.title, WORKFLOW_MAX_TITLE_BYTES, "title"),
    workspace: record.workspace,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    edges: record.edges.slice(0, WORKFLOW_MAX_EDGES).map(boundedWorkflowEdge),
    ...(record.sequence === undefined
      ? {}
      : { sequence: boundedWorkflowSequence(record.sequence) }),
    output_tokens: record.output_tokens,
  };
  if (record.edges.length > WORKFLOW_MAX_EDGES) markWorkflowEdgesTruncated(bounded);
  return bounded;
}

function recordToSummary(record: WorkflowRecord): WorkflowRecordSummary {
  return {
    id: record.id,
    title: record.title,
    workspace: record.workspace,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    leader_count: record.edges.filter((edge) => edge.kind === "leader").length,
  };
}

/** Narrow a persisted checkpoint before it reaches the bounded projection. */
function isWorkflowSequenceRecord(value: unknown): value is WorkflowSequenceRecord {
  const sequence = value as WorkflowSequenceRecord | null;
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === "string";
  const optionalIndex = (field: unknown): boolean =>
    field === undefined || (Number.isInteger(field) && Number(field) >= 0);
  return (
    sequence !== null &&
    typeof sequence === "object" &&
    typeof sequence.session_id === "string" &&
    sequence.session_id.length > 0 &&
    (sequence.status === "running_round" ||
      sequence.status === "awaiting_manager" ||
      sequence.status === "completed" ||
      sequence.status === "stopped" ||
      sequence.status === "failed" ||
      sequence.status === "cancelled") &&
    Number.isInteger(sequence.revision) &&
    sequence.revision >= 0 &&
    optionalString(sequence.round_id) &&
    optionalIndex(sequence.pass) &&
    optionalString(sequence.next_round_id) &&
    optionalIndex(sequence.next_pass) &&
    Number.isInteger(sequence.leaders_started) &&
    sequence.leaders_started >= 0 &&
    Number.isInteger(sequence.max_total_leaders) &&
    sequence.max_total_leaders >= 1 &&
    sequence.leaders_started <= sequence.max_total_leaders &&
    optionalString(sequence.reason)
  );
}

/** Narrow arbitrary parsed JSON to a {@link WorkflowRecord} by shape. */
function isWorkflowRecord(value: unknown): value is WorkflowRecord {
  const record = value as WorkflowRecord | null;
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.id === "string" &&
    typeof record.root_run_id === "string" &&
    typeof record.title === "string" &&
    typeof record.workspace === "string" &&
    typeof record.status === "string" &&
    typeof record.created_at === "number" &&
    Number.isFinite(record.created_at) &&
    typeof record.updated_at === "number" &&
    Number.isFinite(record.updated_at) &&
    Array.isArray(record.edges) &&
    (record.sequence === undefined || isWorkflowSequenceRecord(record.sequence)) &&
    typeof record.output_tokens === "number" &&
    Number.isFinite(record.output_tokens)
  );
}

function isWorkflowSummary(value: unknown): value is WorkflowRecordSummary {
  const summary = value as WorkflowRecordSummary | null;
  return (
    summary !== null &&
    typeof summary === "object" &&
    typeof summary.id === "string" &&
    typeof summary.title === "string" &&
    typeof summary.workspace === "string" &&
    typeof summary.status === "string" &&
    typeof summary.created_at === "number" &&
    Number.isFinite(summary.created_at) &&
    typeof summary.updated_at === "number" &&
    Number.isFinite(summary.updated_at) &&
    typeof summary.leader_count === "number" &&
    Number.isInteger(summary.leader_count) &&
    summary.leader_count >= 0
  );
}

function compareSummaries(left: WorkflowRecordSummary, right: WorkflowRecordSummary): number {
  return right.updated_at - left.updated_at || right.id.localeCompare(left.id);
}

/** Retain a bounded top-K in a worst-first heap. */
function retainSummary(
  heap: WorkflowRecordSummary[],
  summary: WorkflowRecordSummary,
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
      const leftValue = heap[left];
      const currentWorst = heap[worst];
      if (
        leftValue !== undefined &&
        currentWorst !== undefined &&
        compareSummaries(leftValue, currentWorst) > 0
      ) {
        worst = left;
      }
      const rightValue = heap[right];
      const nextWorst = heap[worst];
      if (
        rightValue !== undefined &&
        nextWorst !== undefined &&
        compareSummaries(rightValue, nextWorst) > 0
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
    throw kernelError("cancelled", "workflow catalog request was cancelled");
  }
}

export function normalizeWorkflowPage(page: WorkflowPageRequest): {
  limit: number;
  offset: number;
} {
  const limit = page.limit ?? WORKFLOW_PAGE_DEFAULT;
  const offset = page.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_PAGE_MAX) {
    throw kernelError("invalid_request", "workflow page limit must be between 1 and 200");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > WORKFLOW_PAGE_MAX_OFFSET) {
    throw kernelError("invalid_request", "workflow page offset must be between 0 and 2000");
  }
  return { limit, offset };
}

/** Timer seam for deterministic coalesced-persistence tests. */
export interface WorkflowPersistenceTimer {
  cancel(): void;
}

export interface WorkflowPersistenceRuntime {
  schedule(task: () => void, delayMs: number): WorkflowPersistenceTimer;
}

const SYSTEM_PERSISTENCE_RUNTIME: WorkflowPersistenceRuntime = {
  schedule(task, delayMs): WorkflowPersistenceTimer {
    const timer = setTimeout(task, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Coalesce event-driven full snapshots and provide a synchronous terminal flush. */
export function createWorkflowSaveQueue(options: {
  save: () => void;
  delayMs?: number;
  runtime?: WorkflowPersistenceRuntime;
  onBackgroundError?: (error: unknown) => void;
}): { request(): void; flush(): void } {
  const runtime = options.runtime ?? SYSTEM_PERSISTENCE_RUNTIME;
  const delayMs =
    options.delayMs !== undefined && Number.isFinite(options.delayMs)
      ? Math.max(0, Math.min(1_000, Math.floor(options.delayMs)))
      : WORKFLOW_PERSIST_DELAY_MS;
  let dirty = false;
  let timer: WorkflowPersistenceTimer | undefined;

  const saveDirty = (): void => {
    if (!dirty) return;
    options.save();
    dirty = false;
  };

  return {
    request(): void {
      dirty = true;
      if (timer !== undefined) return;
      timer = runtime.schedule(() => {
        timer = undefined;
        try {
          saveDirty();
        } catch (error) {
          options.onBackgroundError?.(error);
        }
      }, delayMs);
    },
    flush(): void {
      timer?.cancel();
      timer = undefined;
      saveDirty();
    },
  };
}

/**
 * Build a file-backed {@link WorkflowStore} storing one JSON record and one
 * bounded summary sidecar per workflow under the owner-scoped global state tree.
 */
export function createWorkflowStore(opts: { dir: string; owner: string }): FileWorkflowStore {
  const ownerDir = join(globalPaths(opts.dir).workflowRecordsDir, ownerSegment(opts.owner));

  function fileFor(id: string): string {
    return join(ownerDir, `${ownerSegment(id)}.json`);
  }

  function summaryFor(id: string): string {
    return join(ownerDir, `${ownerSegment(id)}.summary.json`);
  }

  function readOne(path: string): WorkflowRecord | null {
    try {
      if (statSync(path).size > WORKFLOW_RECORD_MAX_BYTES) return null;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isWorkflowRecord(parsed) ? boundedWorkflowRecord(parsed) : null;
    } catch {
      return null;
    }
  }

  function serializeSummary(summary: WorkflowRecordSummary): string {
    const serialized = JSON.stringify(summary);
    if (Buffer.byteLength(serialized, "utf8") > WORKFLOW_SUMMARY_MAX_BYTES) {
      throw kernelError("resource_exhausted", "workflow summary exceeds 8 KiB");
    }
    return serialized;
  }

  function serializeRecord(record: WorkflowRecord): {
    record: WorkflowRecord;
    body: string;
    summary: string;
  } {
    const bounded = boundedWorkflowRecord(record);
    const body = JSON.stringify(bounded);
    if (Buffer.byteLength(body, "utf8") > WORKFLOW_RECORD_MAX_BYTES) {
      throw kernelError("resource_exhausted", "workflow record exceeds 8 MiB");
    }
    return { record: bounded, body, summary: serializeSummary(recordToSummary(bounded)) };
  }

  function recordEntries(): Iterable<string> {
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

  function readSummary(
    recordPath: string,
    entry: string,
  ): {
    summary: WorkflowRecordSummary | null;
    inspectedBytes: number;
  } {
    const sidecar = join(ownerDir, `${entry.slice(0, -5)}.summary.json`);
    let inspectedBytes = 0;
    try {
      const bytes = statSync(sidecar).size;
      inspectedBytes += bytes;
      if (bytes > WORKFLOW_SUMMARY_MAX_BYTES) throw new Error("oversized workflow summary");
      const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
      if (isWorkflowSummary(parsed)) return { summary: parsed, inspectedBytes };
    } catch {}

    try {
      inspectedBytes += statSync(recordPath).size;
    } catch {}
    const record = readOne(recordPath);
    if (record === null) return { summary: null, inspectedBytes };
    const summary = recordToSummary(record);
    let serialized: string;
    try {
      serialized = serializeSummary(summary);
    } catch {
      return { summary: null, inspectedBytes };
    }
    try {
      writeFileAtomicSync(summaryFor(summary.id), serialized);
    } catch {
      // Legacy-sidecar repair is opportunistic; the authoritative record remains readable.
    }
    return { summary, inspectedBytes };
  }

  return {
    save(record: WorkflowRecord): void {
      const serialized = serializeRecord(record);
      try {
        unlinkSync(summaryFor(serialized.record.id));
      } catch {
        // Legacy/first saves have no previous sidecar.
      }
      writeFileAtomicSync(fileFor(serialized.record.id), serialized.body);
      writeFileAtomicSync(summaryFor(serialized.record.id), serialized.summary);
    },
    get(id: string): WorkflowRecord | null {
      return readOne(fileFor(id));
    },
    list(): WorkflowRecord[] {
      const records: WorkflowRecord[] = [];
      let inspected = 0;
      let retainedBytes = 0;
      for (const entry of recordEntries()) {
        inspected += 1;
        if (inspected > LEGACY_LIST_MAX) {
          throw kernelError(
            "resource_exhausted",
            "workflow list exceeds 200 full records; use listPage()",
          );
        }
        const path = join(ownerDir, entry);
        let bytes: number;
        try {
          bytes = statSync(path).size;
        } catch {
          continue;
        }
        if (retainedBytes + bytes > LEGACY_LIST_MAX_BYTES) {
          throw kernelError(
            "resource_exhausted",
            "workflow list exceeds 32 MiB of full records; use listPage()",
          );
        }
        const record = readOne(path);
        if (record !== null) {
          records.push(record);
          retainedBytes += bytes;
        }
      }
      return records.sort(
        (left, right) => right.updated_at - left.updated_at || right.id.localeCompare(left.id),
      );
    },
    async listPage(
      page: WorkflowPageRequest = {},
      scan: WorkflowPageScanOptions = {},
    ): Promise<WorkflowRecordPage> {
      const normalized = normalizeWorkflowPage(page);
      const selected: WorkflowRecordSummary[] = [];
      const capacity = normalized.offset + normalized.limit;
      let total = 0;
      let scanned = 0;
      let scannedBytes = 0;
      assertScanActive(scan.signal);
      for (const entry of recordEntries()) {
        assertScanActive(scan.signal);
        const read = readSummary(join(ownerDir, entry), entry);
        if (read.summary !== null) {
          total += 1;
          retainSummary(selected, read.summary, capacity);
        }
        scanned += 1;
        scannedBytes += read.inspectedBytes;
        if (scanned % WORKFLOW_SCAN_BATCH === 0 || scannedBytes >= WORKFLOW_SCAN_BATCH_BYTES) {
          await yieldToEventLoop();
          assertScanActive(scan.signal);
          scannedBytes = 0;
        }
      }
      selected.sort(compareSummaries);
      return {
        items: selected.slice(normalized.offset, normalized.offset + normalized.limit),
        total,
        ...normalized,
      };
    },
    delete(id: string): boolean {
      try {
        unlinkSync(summaryFor(id));
      } catch {
        // Legacy records have no sidecar.
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
