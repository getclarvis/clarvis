/**
 * Structured diagnostics a tool emits about the machinery around a call, and
 * the process-wide sink for the two sites that cannot reach one.
 *
 * @remarks
 * Two seams, because there are genuinely two lifetimes. {@link ToolsLogger}
 * rides on the per-toolset `RuntimeConfig` and is what nearly every site uses.
 * {@link WarnSink} is a single process-wide slot for the memoized/pure sites
 * that have no config in scope — `serializeError` and the `.gitignore` loader.
 */

/**
 * Minimal structural logger.
 *
 * @remarks
 * Deliberately **not** `@clarvis/capability`'s `Logger`: this package's only
 * internal dependency is `@clarvis/paths`, and it stays that way. The
 * capability port satisfies this shape, so a host passes its own logger
 * straight in. Neither package can see both shapes, so the assignability is
 * pinned one package up, in
 * `packages/loop/tests/architecture/logger-drift.test.ts` — `@clarvis/loop` is
 * the lowest package that depends on both, and its tools capability really does
 * hand a contract `Logger` to `createAgentTools`. `@clarvis/hooks` set the same
 * precedent with `HookLogger`, checked in that same file.
 */
export interface ToolsLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * A {@link ToolsLogger} that discards everything, for a toolset whose host
 * supplied none.
 *
 * @remarks Why `RuntimeConfig.logger` is required rather than optional: an
 *   optional-chained call is an extra branch at every one of the sites below,
 *   and this package holds a 0.98/0.98 coverage floor. Absent a host logger the
 *   behaviour is identical either way, so the branch buys nothing.
 */
export const NOOP_TOOLS_LOGGER: ToolsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The structured half of a warning routed through the process-wide
 * {@link WarnSink}.
 *
 * @remarks Carried beside the human-readable message so a host bridging the
 *   sink into a real logger can emit the same stable `event` field every other
 *   site in this package emits, instead of collapsing all three sites into one
 *   undifferentiated `tools.warning`.
 */
export interface ToolsWarning {
  /** The stable, dotted event name; the machine contract. */
  readonly event: string;
  /** Which level the host should emit at. Defaults to `warn`. */
  readonly level?: "debug" | "warn" | "error";
  /** Structured context, already free of secrets and model-authored prose. */
  readonly fields?: Record<string, unknown>;
}

/**
 * A destination for the tools' non-fatal warnings: receives each fully-formed
 * message string (already newline-terminated by the caller) plus, when the site
 * has one, the structured {@link ToolsWarning} describing it.
 */
export type WarnSink = (message: string, warning?: ToolsWarning) => void;

/** The process-wide default sink, which writes each message to `stderr`. */
const defaultSink: WarnSink = (message) => {
  process.stderr.write(message);
};

let sink: WarnSink = defaultSink;

/**
 * Emit a non-fatal warning through the currently installed {@link WarnSink}.
 *
 * @param message - the warning text; callers include their own trailing newline.
 * @param warning - the structured event describing it, when the site has one.
 * @remarks Routes to `stderr` unless a host has redirected it via
 *   {@link setWarnSink} (e.g. a TUI that captures warnings instead of printing).
 */
export function warn(message: string, warning?: ToolsWarning): void {
  sink(message, warning);
}

/**
 * Install or clear the warning sink used by {@link warn}.
 *
 * @param fn - the sink to route warnings to, or `null` to restore the default
 *   `stderr` sink.
 * @remarks
 * The sink is a **single process-wide slot, and the last writer wins.** That is
 * correct for one host process — one kernel, one terminal — and wrong the day a
 * second kernel shares the process: both would install a sink, only the later
 * one would receive anything, and the earlier host's warnings would be
 * attributed to the wrong destination. Anything that can reach a
 * `RuntimeConfig` should use {@link ToolsLogger} instead, which is per-toolset
 * and has no such ambiguity.
 *
 * Until a host installs one the default writes raw text to `process.stderr`,
 * which is why installing it is not optional for a terminal UI: an uninstalled
 * sink paints over the renderer's own canvas, past the silencing the host
 * explicitly asked for.
 */
export function setWarnSink(fn: WarnSink | null): void {
  sink = fn ?? defaultSink;
}
