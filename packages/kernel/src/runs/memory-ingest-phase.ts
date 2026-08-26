/**
 * Shared classification of a `memory_ingest` event's phase.
 *
 * @remarks The single source of truth for "is a memory-ingest phase pending
 * or terminal" — used by {@link createRunService} and the workflows manager's
 * stream to decide whether a run's client-facing stream must stay open, and
 * re-exported from the kernel's public surface so `@clarvis/code`'s status
 * line can classify a {@link MemoryIngestNotice} phase the same way, rather
 * than each side hard-coding its own copy of the same five-value partition.
 */
import type { RunEvent } from "@clarvis/protocol";

/**
 * Whether a `memory_ingest` phase means the durable index job is still in
 * flight — the stream must stay open (up to the grace bound) rather than
 * close.
 *
 * @param phase - the event detail's `phase` field, if present.
 * @returns true for `"started"` and `"queued"` (including a retry-driven
 *   re-`"queued"`); false for the terminal phases `"done"`/`"failed"`/
 *   `"blocked"`, and for an absent/unrecognized phase.
 */
export function isIngestPending(phase: string | undefined): boolean {
  return phase === "started" || phase === "queued";
}

/**
 * Idle bound for a run's client-facing stream after the execution itself has
 * settled while a memory-index notice is still pending.
 *
 * @remarks Memory indexing is durable and independently observable; its retry
 * backoff must not retain a complete run/client graph for minutes. The short
 * sliding window captures the normal immediate completion without coupling
 * protocol resource lifetime to the background retry policy.
 */
export const DEFAULT_INGEST_CLOSE_GRACE_MS = 5_000;

/** Absolute production ceiling across every sliding ingest renewal. */
export const DEFAULT_INGEST_CLOSE_MAX_WAIT_MS = 15_000;

/** No host/test override may retain a settled run beyond one minute. */
export const MAX_INGEST_CLOSE_WAIT_MS = 60_000;

/**
 * Reads a `RunEvent`'s ingest-pending state, so a stream's `push` handler
 * needn't repeat the `event.detail` cast at each call site.
 *
 * @param event - the event just pushed onto the stream.
 * @returns `undefined` when `event` is not a `memory_ingest` event (the
 *   caller should leave its own pending flag untouched); otherwise the
 *   result of {@link isIngestPending} for that event's phase.
 */
export function ingestPendingAfter(event: RunEvent): boolean | undefined {
  if (event.type !== "memory_ingest") return undefined;
  const phase = (event.detail as { phase?: string } | null | undefined)?.phase;
  return isIngestPending(phase);
}
