import type { RecordingTrace, TraceDetailFor, TraceEntry, TraceKind } from "@clarvis/capability";
import type { TraceHandle } from "./trace-handle.ts";
import { capDetail } from "./cap-detail.ts";

/**
 * Creates an in-memory {@link TraceHandle} that accumulates {@link TraceEntry}
 * items and, when given, mirrors each to an `onRecord` callback for live UI
 * bridging.
 *
 * @param startedAt - the `performance.now()` origin against which every entry's
 *   `at` is measured; defaults to the moment of creation, so timestamps are
 *   run-relative milliseconds.
 * @param onRecord - optional sink invoked with each entry produced by `record`
 *   or `signal`, in emission order. Its second argument says whether the entry
 *   is **durable** (`record`) or live-only (`signal`).
 * @returns a {@link TraceHandle} extended with `seal()`; after `seal()`, both
 *   `record` and `signal` become no-ops.
 * @remarks `record` both appends to the persisted `entries` and notifies
 *   `onRecord`; `signal` only notifies (live-only, never persisted) — see
 *   {@link TraceHandle.signal}.
 *
 *   The `durable` flag exists because both paths reach the *same* sink with
 *   structurally identical entries, so a consumer that must persist cannot tell
 *   them apart from the entry alone. Without it, anything writing this sink to
 *   disk would also write every streaming delta — an unbounded channel the
 *   batch persistence path does not have.
 *
 *   Both run their payload through {@link capDetail} first, so nothing that
 *   leaves this handle — into the retained `entries` array or out to `onRecord`
 *   — carries more free text than any consumer will ever read. The array lives
 *   for the whole run, while every reader of it already truncates: the
 *   Tool results are capped at 5000 characters, the supervision registry reads
 *   a 2 KiB tail, and context compaction has its own `maxResultChars`. Final
 *   model responses use a separate 2 MiB transcript-prose ceiling; applying the
 *   compact tool-result cap there would destroy the user-visible answer before
 *   persistence or the UI can choose how much to mount. Recording a 128 KiB tool
 *   result whole — or, on the MCP path, one with no upstream bound at all — was
 *   retaining roughly twenty-six times what any tool-result consumer reads, per
 *   call, until the run ended.
 */
export function createTrace(
  startedAt: number = performance.now(),
  onRecord?: (entry: TraceEntry, durable: boolean) => void,
): TraceHandle & { seal: () => void } {
  const trace: RecordingTrace = { entries: [] };
  let sealed = false;
  const now = (): number => performance.now() - startedAt;
  const record = <K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void => {
    if (sealed) return;
    const entry = { at: now(), kind, detail: capDetail(kind, detail) } as TraceEntry;
    trace.entries.push(entry);
    onRecord?.(entry, true);
  };
  const signal = <K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void => {
    if (sealed) return;
    const entry = { at: now(), kind, detail: capDetail(kind, detail) } as TraceEntry;
    onRecord?.(entry, false);
  };
  const entries = (): TraceEntry[] => trace.entries;
  const seal = (): void => {
    sealed = true;
  };
  return { trace, record, signal, entries, now, seal };
}
