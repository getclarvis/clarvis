/**
 * The trace vocabulary: the kinds a run records, their detail payloads, and the
 * persisted projection a host reads back.
 *
 * @remarks Separate from the package root so a capability that only records
 * events does not pull the whole contract in, and so the open/closed split
 * ({@link TraceKind} vs `BuiltinTraceKind`) is visible at the import site.
 */
export * from "./trace-kinds.ts";
export type {
  Trace,
  TraceEvent,
  BuiltinTraceEvent,
  ContributedTraceEvent,
  PersistedContributedTraceEvent,
  ExecutionRecord,
  ExecutionRecovery,
  ExecutionStatus,
} from "./trace-events.ts";
export { BUILTIN_TRACE_EVENT_TYPES, isBuiltinTraceEvent } from "./trace-events.ts";
export * from "./trace-projectors.ts";
