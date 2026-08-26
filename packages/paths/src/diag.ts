/**
 * The structured diagnostics this package emits about the filesystem machinery
 * behind the directory vocabulary, and the process-wide sink the sites that
 * cannot receive one reach it through.
 *
 * @remarks
 * Two seams, because there are genuinely two lifetimes. Most sites take a
 * {@link PathsLogger} on the options bag they already have — the lease options,
 * {@link ../atomic.js#AtomicWriteOptions}, the sweep options, the root options —
 * so a caller's logger keeps its own bindings. The four entry points that have
 * no options bag at all (`ensureWorkspaceDir`, `ensureWorkspaceSubdir`,
 * `fsyncDir`, `resolveCommand`, together roughly seventy call sites) reach
 * {@link pathsLogger} instead, which a host installs once at boot.
 */

/**
 * Minimal structural logger.
 *
 * @remarks
 * Deliberately **not** `@clarvis/capability`'s `Logger`: this package has no
 * dependencies at all, internal or external, and `tooling/checks/package-graph.ts`
 * enforces that. The capability port satisfies this shape, so a host passes its
 * own logger straight in; the drift test lives in
 * `packages/loop/tests/integration/execute-run-entrypoints.test.ts`, because a
 * test here may not import the package it would have to compare against.
 * `@clarvis/hooks` set this precedent with `HookLogger` and `@clarvis/tools`
 * followed it with `ToolsLogger`.
 */
export interface PathsLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * A {@link PathsLogger} that discards everything.
 *
 * @remarks
 * The default of every seam in this package, and it must stay a no-op rather
 * than a console fallback: `@clarvis/code` imports this package directly to
 * locate the two roots *before a kernel exists*, so a default that wrote to
 * `stderr` would paint over the terminal UI's first frame. Nothing here may
 * ever reach `process.stdout` or `process.stderr`.
 */
export const NOOP_PATHS_LOGGER: PathsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let sink: PathsLogger = NOOP_PATHS_LOGGER;

/** How many distinct {@link announceOnce} keys are remembered before a reset. */
const ANNOUNCE_MAX_KEYS = 256;

const announced = new Set<string>();

/**
 * Install or clear the process-wide logger the options-less sites emit through.
 *
 * @param logger - the logger to route to, or `null` to restore the no-op.
 *
 * @remarks
 * **Host boot only, never per run.** It is a single slot and the last writer
 * wins, which is correct for one host process — one kernel, one destination —
 * and ambiguous the moment two hosts share a process. Anything that can reach
 * an options bag should pass its own {@link PathsLogger} there instead, which
 * is per-call and has no such ambiguity.
 *
 * Installing a sink also resets the {@link announceOnce} gates, so a host that
 * installs one at boot still sees the first occurrence of each once-per-process
 * fact rather than one already consumed before it arrived.
 */
export function setPathsLogger(logger: PathsLogger | null): void {
  sink = logger ?? NOOP_PATHS_LOGGER;
  announced.clear();
}

/**
 * The currently installed process-wide logger.
 *
 * @returns the installed {@link PathsLogger}, or {@link NOOP_PATHS_LOGGER}.
 */
export function pathsLogger(): PathsLogger {
  return sink;
}

/**
 * Whether this is the first time `key` has been announced.
 *
 * @param key - the distinguishing identity of the fact being reported.
 * @returns `true` exactly once per key, until a sink is installed or the key
 *   budget is exhausted.
 *
 * @remarks A steady-state fact — a filesystem that will not sync a directory
 *   handle, the roots this process resolved — is worth saying once and
 *   worthless said continuously. The key must carry the distinguishing
 *   identity, or two different causes collapse into one line naming neither.
 *   The budget is cleared rather than evicted one entry at a time: a process
 *   that produced 256 distinct steady-state facts is not in a steady state.
 */
export function announceOnce(key: string): boolean {
  if (announced.has(key)) return false;
  if (announced.size >= ANNOUNCE_MAX_KEYS) announced.clear();
  announced.add(key);
  return true;
}
