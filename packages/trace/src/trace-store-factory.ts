import type { Logger } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { createJsonTraceStore } from "./json-trace-store.ts";
import type { TraceStore } from "./trace-store.ts";

/** Options for {@link resolveTraceStore}. */
export interface ResolveTraceStoreOptions {
  /** Override directory for the trace store; a blank or omitted value falls
   * back to the global traces directory. */
  dir?: string;
  /** Passed straight to the store; see `JsonTraceStoreOptions.logger`. */
  logger?: Logger;
}

/** The resolved store together with the directory it was opened on. */
export interface ResolvedTraceStore {
  /** The backing JSON trace store. */
  store: TraceStore;
  /** The absolute directory the store persists into. */
  path: string;
}

/**
 * Open a JSON-file {@link TraceStore} at an explicit directory or the default.
 *
 * @param opts - optional directory override; see {@link ResolveTraceStoreOptions}.
 * @returns the store and the resolved directory it writes to. A whitespace-only
 *   or missing `dir` resolves to the global traces directory.
 */
export function resolveTraceStore(opts: ResolveTraceStoreOptions = {}): ResolvedTraceStore {
  const trimmed = opts.dir?.trim();
  const path = trimmed !== undefined && trimmed.length > 0 ? trimmed : globalPaths().tracesDir;
  const store = createJsonTraceStore({
    dir: path,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return { store, path };
}
