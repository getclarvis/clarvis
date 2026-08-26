import type { RecordingTrace, TraceEntry, TracePort } from "@clarvis/capability";

/**
 * The write side of a run trace: append durable entries, emit live-only
 * signals, and read back what has been recorded so far.
 *
 * @remarks Implemented by {@link createTrace}. The generic `kind`/`detail`
 *   pairing is enforced through {@link TraceDetailFor}, so a built-in kind has
 *   its detail shape checked at the call site while a kind contributed by a
 *   capability outside the engine is accepted with a `detail` of `unknown`.
 */
export interface TraceHandle extends TracePort {
  /** Returns the durable entries recorded so far, in emission order. */
  entries: () => TraceEntry[];
  /** The backing {@link RecordingTrace} holding the persisted entries. */
  trace: RecordingTrace;
}
