import { ConflictError } from "@clarvis/capability";
import { sanitizeDeep } from "@clarvis/capability";
import {
  recordToSummary,
  sortDescPaginate,
  type ListResult,
  type StoredExecution,
  type TraceStore,
} from "./trace-store.ts";

/**
 * In-memory TraceStore double with the same persistence semantics as the real
 * stores (owner scoping, id conflict, sanitize-on-insert). Shared through
 * `./testing` so downstream packages test against one implementation.
 *
 * @remarks `insert` returns a settled promise rather than being declared
 * `async`: a conflict has to arrive as a *rejection*, matching the real store,
 * or a caller written against one would break against the other — but the body
 * does no awaiting and `async` on it only trips `require-await`.
 */
export function createMemoryTraceStore(): TraceStore {
  const byOwner = new Map<string, Map<string, StoredExecution>>();

  const ownerMap = (owner: string): Map<string, StoredExecution> => {
    let m = byOwner.get(owner);
    if (m === undefined) {
      m = new Map();
      byOwner.set(owner, m);
    }
    return m;
  };

  return {
    insert(record): Promise<void> {
      const m = ownerMap(record.owner_key_name);
      if (m.has(record.id)) {
        return Promise.reject(
          new ConflictError(`execution_id '${record.id}' already exists for this key.`, {
            execution_id: record.id,
          }),
        );
      }
      m.set(record.id, {
        id: record.id,
        owner_key_name: record.owner_key_name,
        status: record.status,
        started_at: record.started_at,
        ended_at: record.ended_at,
        elapsed_ms: record.elapsed_ms,
        request: sanitizeDeep(record.request),
        response: sanitizeDeep(record.response),
        trace: structuredClone(record.trace),
        total_input_tokens: record.total_input_tokens,
        total_output_tokens: record.total_output_tokens,
        total_cached_tokens: record.total_cached_tokens,
        total_cache_write_tokens: record.total_cache_write_tokens,
        ...(record.final_context !== undefined
          ? { final_context: structuredClone(record.final_context) }
          : {}),
        ...(record.capability_state !== undefined
          ? { capability_state: structuredClone(record.capability_state) }
          : {}),
      });
      return Promise.resolve();
    },

    getById(owner, id): StoredExecution | null {
      return byOwner.get(owner)?.get(id) ?? null;
    },

    replaceFinalContext(owner, id, context, usage): Promise<boolean> {
      const record = byOwner.get(owner)?.get(id);
      if (record === undefined) return Promise.resolve(false);
      record.final_context = structuredClone([...context]);
      record.total_input_tokens += usage?.input ?? 0;
      record.total_output_tokens += usage?.output ?? 0;
      record.total_cached_tokens += usage?.cached ?? 0;
      record.total_cache_write_tokens += usage?.cache_write ?? 0;
      return Promise.resolve(true);
    },

    existsForOwner(owner, id): boolean {
      return byOwner.get(owner)?.has(id) ?? false;
    },

    list(owner, limit, offset): ListResult {
      const all = [...(byOwner.get(owner)?.values() ?? [])];
      return {
        items: sortDescPaginate(all, limit, offset).map(recordToSummary),
        total: all.length,
      };
    },

    deleteById(owner, id): boolean {
      return byOwner.get(owner)?.delete(id) ?? false;
    },

    deleteOwner(owner): number {
      const removed = byOwner.get(owner)?.size ?? 0;
      byOwner.delete(owner);
      return removed;
    },

    listAcrossOwners(limit, offset, filter): ListResult {
      const all =
        filter?.owner !== undefined
          ? [...(byOwner.get(filter.owner)?.values() ?? [])]
          : [...byOwner.values()].flatMap((m) => [...m.values()]);
      return {
        items: sortDescPaginate(all, limit, offset).map(recordToSummary),
        total: all.length,
      };
    },

    cleanup(cutoffMs, batch, _counters, protectedExecutionIds): number {
      const expired: StoredExecution[] = [];
      for (const m of byOwner.values()) {
        for (const rec of m.values()) {
          if (rec.started_at < cutoffMs && !protectedExecutionIds?.has(rec.id)) expired.push(rec);
        }
      }
      expired.sort((a, b) => a.started_at - b.started_at);
      let deleted = 0;
      for (const rec of expired) {
        if (deleted >= batch) break;
        byOwner.get(rec.owner_key_name)?.delete(rec.id);
        deleted += 1;
      }
      return deleted;
    },
  };
}
