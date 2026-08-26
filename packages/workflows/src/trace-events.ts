import type {
  PersistedTraceProjection,
  PersistedTraceProjector,
  TraceEvent,
  TracePort,
} from "@clarvis/capability";

/** Workflow-owned trace kinds recorded around each leader run. */
export const WORKFLOW_RUN_STARTED_TRACE_KIND = "workflow_run_started";
export const WORKFLOW_RUN_COMPLETED_TRACE_KIND = "workflow_run_completed";
export const WORKFLOW_RUN_FAILED_TRACE_KIND = "workflow_run_failed";

export const WORKFLOW_TRACE_KINDS = [
  WORKFLOW_RUN_STARTED_TRACE_KIND,
  WORKFLOW_RUN_COMPLETED_TRACE_KIND,
  WORKFLOW_RUN_FAILED_TRACE_KIND,
] as const;

export type WorkflowTraceKind = (typeof WORKFLOW_TRACE_KINDS)[number];

/** Detail recorded when a manager-owned leader begins execution. */
export interface WorkflowRunStartedDetail {
  run_id: string;
  parent_run_id: string;
  title: string;
  task: string;
  profile?: string;
  round_id?: string;
  pass?: number;
  item_index?: number;
  replica?: number;
  replica_count?: number;
}

/** Detail recorded when a manager-owned leader settles. */
export interface WorkflowRunFinishedDetail {
  run_id: string;
  parent_run_id: string;
  status: string;
  error?: { code: string; message: string };
}

export interface WorkflowTraceDetailMap {
  workflow_run_started: WorkflowRunStartedDetail;
  workflow_run_completed: WorkflowRunFinishedDetail;
  workflow_run_failed: WorkflowRunFinishedDetail;
}

/** Persisted start edge projected by the workflows capability. */
export interface WorkflowRunStartedTraceEvent extends PersistedTraceProjection {
  readonly type: "workflow_run_started";
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly started_at: number;
  /** Absent only on traces written before titles and tasks were separated. */
  readonly title?: string;
  readonly task: string;
  readonly profile?: string;
  readonly round_id?: string;
  readonly pass?: number;
  readonly item_index?: number;
  readonly replica?: number;
  readonly replica_count?: number;
}

/** Persisted successful terminal edge projected by the workflows capability. */
export interface WorkflowRunCompletedTraceEvent extends PersistedTraceProjection {
  readonly type: "workflow_run_completed";
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly completed_at: number;
  readonly status: string;
}

/** Persisted failed terminal edge projected by the workflows capability. */
export interface WorkflowRunFailedTraceEvent extends PersistedTraceProjection {
  readonly type: "workflow_run_failed";
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly completed_at: number;
  readonly status: string;
  readonly error?: { code: string; message: string };
}

/** The narrow public persisted-event union the kernel maps to protocol DTOs. */
export type WorkflowPersistedTraceEvent =
  WorkflowRunStartedTraceEvent | WorkflowRunCompletedTraceEvent | WorkflowRunFailedTraceEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function hasFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "number" && Number.isFinite(record[key]);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function hasOptionalNonnegativeInteger(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function isWorkflowError(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && hasString(value, "code") && hasString(value, "message");
}

/** Validate the detail associated with `workflow_run_started`. */
export function isWorkflowRunStartedDetail(value: unknown): value is WorkflowRunStartedDetail {
  return (
    isRecord(value) &&
    hasString(value, "run_id") &&
    hasString(value, "parent_run_id") &&
    hasString(value, "title") &&
    hasString(value, "task") &&
    hasOptionalString(value, "profile") &&
    hasOptionalString(value, "round_id") &&
    hasOptionalNonnegativeInteger(value, "pass") &&
    hasOptionalNonnegativeInteger(value, "item_index") &&
    hasOptionalNonnegativeInteger(value, "replica") &&
    hasOptionalNonnegativeInteger(value, "replica_count")
  );
}

/** Validate the detail associated with either terminal workflow trace kind. */
export function isWorkflowRunFinishedDetail(value: unknown): value is WorkflowRunFinishedDetail {
  return (
    isRecord(value) &&
    hasString(value, "run_id") &&
    hasString(value, "parent_run_id") &&
    hasString(value, "status") &&
    (value.error === undefined || isWorkflowError(value.error))
  );
}

/**
 * Narrow any persisted engine event to the three workflow-owned projections.
 *
 * @remarks The discriminator alone is insufficient: journals are intentionally
 * lenient and can contain events written by newer or malformed producers. The
 * kernel uses this guard before mapping a contributed event to a protocol DTO.
 */
export function isWorkflowPersistedTraceEvent(
  event: TraceEvent,
): event is WorkflowPersistedTraceEvent {
  if (!isRecord(event)) return false;
  const record = event;
  switch (event.type) {
    case WORKFLOW_RUN_STARTED_TRACE_KIND:
      return (
        hasString(record, "run_id") &&
        hasString(record, "parent_run_id") &&
        hasFiniteNumber(record, "started_at") &&
        hasOptionalString(record, "title") &&
        hasString(record, "task") &&
        hasOptionalString(record, "profile") &&
        hasOptionalString(record, "round_id") &&
        hasOptionalNonnegativeInteger(record, "pass") &&
        hasOptionalNonnegativeInteger(record, "item_index") &&
        hasOptionalNonnegativeInteger(record, "replica") &&
        hasOptionalNonnegativeInteger(record, "replica_count")
      );
    case WORKFLOW_RUN_COMPLETED_TRACE_KIND:
      return (
        hasString(record, "run_id") &&
        hasString(record, "parent_run_id") &&
        hasFiniteNumber(record, "completed_at") &&
        hasString(record, "status")
      );
    case WORKFLOW_RUN_FAILED_TRACE_KIND: {
      const error: unknown = Reflect.get(record, "error");
      return (
        hasString(record, "run_id") &&
        hasString(record, "parent_run_id") &&
        hasFiniteNumber(record, "completed_at") &&
        hasString(record, "status") &&
        (error === undefined || isWorkflowError(error))
      );
    }
    default:
      return false;
  }
}

function invalidDetail(kind: WorkflowTraceKind): never {
  throw new TypeError(`invalid ${kind} trace detail`);
}

/** Record a workflow trace entry with capability-owned compile-time detail checking. */
export function recordWorkflowTrace(
  trace: TracePort,
  kind: typeof WORKFLOW_RUN_STARTED_TRACE_KIND,
  detail: WorkflowRunStartedDetail,
): void;
export function recordWorkflowTrace(
  trace: TracePort,
  kind: typeof WORKFLOW_RUN_COMPLETED_TRACE_KIND | typeof WORKFLOW_RUN_FAILED_TRACE_KIND,
  detail: WorkflowRunFinishedDetail,
): void;
export function recordWorkflowTrace(
  trace: TracePort,
  kind: WorkflowTraceKind,
  detail: unknown,
): void {
  trace.record(kind, detail);
}

/**
 * Canonical persisted projections for the three workflow trace kinds.
 *
 * @remarks Each projector validates its opaque contributed detail before
 * reading it. Property insertion order is intentional: these objects preserve
 * the pre-extraction JSON bytes as well as the public field shapes.
 */
export const WORKFLOW_PERSISTED_TRACE_PROJECTORS: readonly PersistedTraceProjector[] = [
  {
    kind: WORKFLOW_RUN_STARTED_TRACE_KIND,
    project(entry, context): WorkflowRunStartedTraceEvent {
      const detail = isWorkflowRunStartedDetail(entry.detail)
        ? entry.detail
        : invalidDetail(WORKFLOW_RUN_STARTED_TRACE_KIND);
      return {
        type: WORKFLOW_RUN_STARTED_TRACE_KIND,
        run_id: detail.run_id,
        parent_run_id: detail.parent_run_id,
        started_at: context.absoluteTime(entry.at),
        title: detail.title,
        task: detail.task,
        ...(detail.profile === undefined ? {} : { profile: detail.profile }),
        ...(detail.round_id === undefined ? {} : { round_id: detail.round_id }),
        ...(detail.pass === undefined ? {} : { pass: detail.pass }),
        ...(detail.item_index === undefined ? {} : { item_index: detail.item_index }),
        ...(detail.replica === undefined ? {} : { replica: detail.replica }),
        ...(detail.replica_count === undefined ? {} : { replica_count: detail.replica_count }),
      };
    },
  },
  {
    kind: WORKFLOW_RUN_COMPLETED_TRACE_KIND,
    project(entry, context): WorkflowRunCompletedTraceEvent {
      const detail = isWorkflowRunFinishedDetail(entry.detail)
        ? entry.detail
        : invalidDetail(WORKFLOW_RUN_COMPLETED_TRACE_KIND);
      return {
        type: WORKFLOW_RUN_COMPLETED_TRACE_KIND,
        run_id: detail.run_id,
        parent_run_id: detail.parent_run_id,
        completed_at: context.absoluteTime(entry.at),
        status: detail.status,
      };
    },
  },
  {
    kind: WORKFLOW_RUN_FAILED_TRACE_KIND,
    project(entry, context): WorkflowRunFailedTraceEvent {
      const detail = isWorkflowRunFinishedDetail(entry.detail)
        ? entry.detail
        : invalidDetail(WORKFLOW_RUN_FAILED_TRACE_KIND);
      return {
        type: WORKFLOW_RUN_FAILED_TRACE_KIND,
        run_id: detail.run_id,
        parent_run_id: detail.parent_run_id,
        completed_at: context.absoluteTime(entry.at),
        status: detail.status,
        ...(detail.error === undefined ? {} : { error: detail.error }),
      };
    },
  },
] as const;
