/**
 * The terminal statuses a run may finish with, as a readonly tuple usable for
 * runtime validation and enumeration.
 *
 * @remarks `completed` is a normal finish; `budget_exhausted` and
 * `soft_limit_declined` are budget outcomes; `cancelled` is an external stop;
 * `error` is a fault; `interrupted` is a run whose process died before it could
 * persist itself, reconstructed afterwards from its journal. See
 * {@link ExecutionStatus} for the derived union.
 *
 * `interrupted` is never produced by a live run - only by `@clarvis/trace`'s
 * `TraceStore.recoverOrphans`.
 * It maps to protocol `failed` through the kernel's existing collapse, so no
 * wire change follows from adding it.
 */
export const EXECUTION_STATUSES = [
  "completed",
  "budget_exhausted",
  "error",
  "cancelled",
  "soft_limit_declined",
  "interrupted",
] as const;

/** A run's terminal status - one of {@link EXECUTION_STATUSES}. */
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
