import { PersistenceError } from "@clarvis/capability";
import type {
  ContextSnapshotEntry,
  ExecutionRecord,
  ExecutionVisibility,
  TraceEvent,
} from "@clarvis/capability";
import type { JournalHeader, OpenJournalOptions, RunJournal } from "./journal.ts";
import type { TraceStore } from "./trace-store.ts";

/** Host-owned projections for every payload-bearing write to a trace store. */
export interface TraceWriteProjection {
  /** Reconstruct a valid header before the physical journal can be opened. */
  header(header: Omit<JournalHeader, "v">): Omit<JournalHeader, "v">;
  /** Reconstruct a durable event, or omit it; unknown shapes must throw. */
  event(event: TraceEvent): TraceEvent | null;
  /** Reconstruct the complete record, including its response and trace. */
  record(record: ExecutionRecord): ExecutionRecord;
  /** Reconstruct a replacement snapshot, including an empty snapshot when private. */
  context(context: readonly ContextSnapshotEntry[]): readonly ContextSnapshotEntry[];
}

/** Convert projection faults without exposing private exception text to diagnostics. */
function project<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new PersistenceError("Trace write projection failed.");
  }
}

/**
 * Wrap one physical store with mandatory host-owned write projections.
 *
 * Reads and maintenance retain the underlying store's semantics. This adapter is
 * not a visibility filter; the host must compose the appropriate read view.
 * Header, record and context projection failures prevent the write. An event
 * projection failure disables only that journal, once, following the journal's
 * best-effort contract. No path retries with the unprojected payload.
 */
export function projectTraceStoreWrites(
  store: TraceStore,
  projection: TraceWriteProjection,
): TraceStore {
  const openJournal = store.openJournal?.bind(store);
  const readEvents = store.readEvents?.bind(store);
  const listAcrossOwners = store.listAcrossOwners?.bind(store);
  const recoverOrphans = store.recoverOrphans?.bind(store);
  return {
    executionIdNamespace: store.executionIdNamespace ?? store,
    ...(store.viewVisibility === undefined ? {} : { viewVisibility: store.viewVisibility }),
    ...(store.visibilityQueries === true ? { visibilityQueries: true as const } : {}),
    async insert(record) {
      const projected = project(() => projection.record(record));
      await store.insert(projected);
    },
    getById: (owner, id, visibility) => store.getById(owner, id, visibility),
    ...(readEvents === undefined ? {} : { readEvents }),
    async replaceFinalContext(owner, id, context, usage, visibility) {
      const projected = project(() => projection.context(context));
      return await store.replaceFinalContext(owner, id, projected, usage, visibility);
    },
    list: (owner, limit, offset, visibility) => store.list(owner, limit, offset, visibility),
    deleteById: (owner, id, visibility) => store.deleteById(owner, id, visibility),
    deleteOwner: (owner) => store.deleteOwner(owner),
    existsForOwner: (owner, id) => store.existsForOwner(owner, id),
    cleanup: (cutoff, batch, counters, protectedIds) =>
      store.cleanup(cutoff, batch, counters, protectedIds),
    ...(listAcrossOwners === undefined
      ? {}
      : {
          listAcrossOwners: (
            limit: number,
            offset: number,
            filter?: {
              owner?: string;
              visibility?: ExecutionVisibility;
            },
          ) => listAcrossOwners(limit, offset, filter),
        }),
    ...(recoverOrphans === undefined ? {} : { recoverOrphans: () => recoverOrphans() }),
    ...(openJournal === undefined
      ? {}
      : {
          openJournal(options: OpenJournalOptions): RunJournal {
            const header = project(() => projection.header(options.header));
            const journal = openJournal({
              header,
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            });
            let disabled = false;
            return {
              append(event) {
                if (disabled || event === null) return;
                try {
                  journal.append(projection.event(event));
                } catch {
                  disabled = true;
                  journal.close();
                  options.logger?.warn(
                    { event: "trace.journal_projection_failed" },
                    "projected journal disabled; the run continues without crash recovery",
                  );
                }
              },
              close() {
                disabled = true;
                journal.close();
              },
              discard() {
                disabled = true;
                journal.discard();
              },
            };
          },
        }),
  };
}
