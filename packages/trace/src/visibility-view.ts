import { PersistenceError } from "@clarvis/capability";
import type { ExecutionVisibility } from "@clarvis/capability";
import type { OpenJournalOptions } from "./journal.ts";
import type { TraceStore } from "./trace-store.ts";
import { assertExecutionVisibility } from "./visibility.ts";

/**
 * Select one disclosure class before lookup, mutation, pagination and totals.
 * The physical namespace and owner-wide maintenance remain shared across classes.
 * A backend without native visibility queries is rejected; late page filtering
 * cannot implement this contract. Writes must already carry the selected class.
 */
export function createTraceVisibilityView(
  store: TraceStore,
  visibility: ExecutionVisibility,
): TraceStore {
  assertExecutionVisibility(visibility);
  if (store.visibilityQueries !== true)
    throw new PersistenceError("Trace backend does not support visibility queries.");
  if (store.viewVisibility === visibility) return store;
  if (store.viewVisibility !== undefined)
    throw new PersistenceError("Cannot broaden a classified trace view.");
  const requireClass = (actual: ExecutionVisibility): void => {
    if (actual !== visibility)
      throw new PersistenceError("Execution visibility does not match its store view.");
  };
  const openJournal = store.openJournal?.bind(store);
  const readEvents = store.readEvents?.bind(store);
  const recoverOrphans = store.recoverOrphans?.bind(store);
  const listAcrossOwners = store.listAcrossOwners?.bind(store);
  return {
    visibilityQueries: true,
    viewVisibility: visibility,
    executionIdNamespace: store.executionIdNamespace ?? store,
    async insert(record) {
      requireClass(record.visibility);
      await store.insert(record);
    },
    getById: (owner, id) => store.getById(owner, id, visibility),
    ...(readEvents === undefined
      ? {}
      : { readEvents: (owner: string, id: string) => readEvents(owner, id, visibility) }),
    replaceFinalContext: (owner, id, context, usage) =>
      store.replaceFinalContext(owner, id, context, usage, visibility),
    list: (owner, limit, offset) => store.list(owner, limit, offset, visibility),
    deleteById: (owner, id) => store.deleteById(owner, id, visibility),
    existsForOwner: (owner, id) => store.existsForOwner(owner, id),
    deleteOwner: (owner) => store.deleteOwner(owner),
    cleanup: (cutoff, batch, counters, protectedIds) =>
      store.cleanup(cutoff, batch, counters, protectedIds),
    ...(listAcrossOwners === undefined
      ? {}
      : {
          listAcrossOwners: (limit: number, offset: number, filter?: { owner?: string }) =>
            listAcrossOwners(limit, offset, { ...filter, visibility }),
        }),
    ...(recoverOrphans === undefined ? {} : { recoverOrphans: () => recoverOrphans() }),
    ...(openJournal === undefined
      ? {}
      : {
          openJournal(options: OpenJournalOptions) {
            requireClass(options.header.visibility);
            return openJournal(options);
          },
        }),
  };
}
