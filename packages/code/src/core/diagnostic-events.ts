const DEFAULT_ASYNC_SLOW_MS = 10_000;

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticDetails = Readonly<Record<string, unknown>>;

/** Every {@link DiagnosticLevel}, least to most severe, so a filter can compare ranks. */
export const DIAGNOSTIC_LEVELS: readonly DiagnosticLevel[] = ["debug", "info", "warn", "error"];

/** The level a session records at when nothing narrower is asked for. */
export const DEFAULT_DIAGNOSTIC_LEVEL: DiagnosticLevel = "debug";

/**
 * Whether `value` names a {@link DiagnosticLevel}.
 *
 * @param value - a candidate level, typically from `--debug=<level>` or an
 *   environment variable.
 * @returns `true` when the string is one of the four recorded levels.
 */
export function isDiagnosticLevel(value: string): value is DiagnosticLevel {
  return (DIAGNOSTIC_LEVELS as readonly string[]).includes(value);
}

interface LogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/** The structural logger accepted by the kernel without exposing its implementation package. */
export interface DiagnosticLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /**
   * Derive a logger that stamps `bindings` on every record it writes.
   *
   * @param bindings - fields merged into the derived logger's records, the
   *   kernel's `component` above all.
   * @param options - `level` narrows the derived logger further; the effective
   *   floor is the stricter of it and the session's own.
   * @remarks Optional on the port, required in practice. The kernel's
   *   `createComponentLoggers` reaches for it to give each subsystem its
   *   `CLARVIS_LOG=<component>=<level>` scope, and falls back to the root logger
   *   when it is absent — a correct degradation that nonetheless made the
   *   standard's headline configuration knob inert on this host, and kept
   *   `component` off every record.
   */
  child?(bindings: Record<string, unknown>, options?: { level?: string }): DiagnosticLogger;
  /** The floor this logger records at, for a caller guarding a hot site. */
  readonly level?: string;
}

export interface DiagnosticSession {
  readonly path: string;
  readonly logger: DiagnosticLogger;
  /** The floor below which a record is discarded rather than written. */
  readonly level: DiagnosticLevel;
  /**
   * Retune the floor of a session that is already open.
   *
   * @param level - the new floor.
   * @remarks Exists so `/debug <level>` can retune the session the process is
   *   already writing to instead of opening a second file. Opening a second one
   *   splits the record: the kernel's logger is captured once at construction,
   *   so it keeps writing into the first file while this UI's own events move to
   *   the new one, and neither file is the whole story.
   */
  setLevel(level: DiagnosticLevel): void;
  event(event: string, details?: DiagnosticDetails, level?: DiagnosticLevel): void;
  count(event: string, details?: DiagnosticDetails, counterKey?: string): void;
  /**
   * Stamp `fields` onto every later record's envelope.
   *
   * @param fields - correlation identities such as `workspace`, `session_id`
   *   or `execution_id`; a key given `undefined` is removed again.
   */
  bind(fields: DiagnosticDetails): void;
  close(): void;
}

let activeSession: DiagnosticSession | undefined;

/** Install the process-wide session used by low-cost diagnostic call sites. */
export function installDiagnosticSession(session: DiagnosticSession): () => void {
  activeSession = session;
  return () => {
    if (activeSession === session) activeSession = undefined;
  };
}

/**
 * The installed session's logger, for a host handing one to the kernel.
 *
 * @returns the active session's {@link DiagnosticLogger}, or `undefined` when no
 *   session is installed.
 * @remarks The free functions above cover a call site inside this package; a
 *   kernel needs the logger object itself, and non-interactive modes construct
 *   their kernel before — and without — the interactive boot path.
 */
export function activeDiagnosticLogger(): DiagnosticLogger | undefined {
  return activeSession?.logger;
}

/**
 * The installed session itself, for a surface that reports on diagnostics.
 *
 * @returns the active {@link DiagnosticSession}, or `undefined` when none is
 *   installed.
 * @remarks `/debug` and the doctor's diagnostics row both need the *state* of
 *   the channel — whether it is open, where it writes and at what level — which
 *   the fire-and-forget free functions deliberately do not expose.
 */
export function activeDiagnosticSession(): DiagnosticSession | undefined {
  return activeSession;
}

/**
 * Stamp correlation identities onto every later record of the active session.
 *
 * @param fields - the bindings to merge; a key given `undefined` is removed.
 * @remarks Inert when no session is installed, exactly like
 *   {@link diagnosticEvent}. The envelope otherwise carries only `pid` and
 *   `seq`, so a `code` record could be joined to a kernel run by timestamp
 *   alone even though `execution_id` exists on both sides.
 */
export function diagnosticBind(fields: DiagnosticDetails): void {
  activeSession?.bind(fields);
}

export function diagnosticEvent(
  event: string,
  details?: DiagnosticDetails,
  level?: DiagnosticLevel,
): void {
  activeSession?.event(event, details, level);
}

export function diagnosticCount(
  event: string,
  details?: DiagnosticDetails,
  counterKey?: string,
): void {
  activeSession?.count(event, details, counterKey);
}

export interface DiagnosticAsyncOptions {
  /** Duration after which a still-pending operation gets one warning. */
  slowMs?: number;
  /** Optional UI projection of that warning; failures are diagnostic-only. */
  onSlow?: (elapsedMs: number) => void;
}

/**
 * Observe one physical async operation with a common bounded vocabulary.
 *
 * This deliberately does not race the operation with a timeout. Without an
 * AbortSignal on the lower contract, doing so would only lose the reference
 * and let the next refresh start beside work that is still physically alive.
 */
export async function diagnosticAsync<T>(
  operation: string,
  run: () => Promise<T>,
  options: DiagnosticAsyncOptions = {},
): Promise<T> {
  // With no diagnostic sink and no UI-facing slow callback, observing the
  // promise would only allocate a timer and closures in ordinary production
  // runs. Debug mode installs the sink before any instrumented work begins.
  if (activeSession === undefined && options.onSlow === undefined) return run();
  const startedAt = Date.now();
  const slowMs = Math.max(1, options.slowMs ?? DEFAULT_ASYNC_SLOW_MS);
  diagnosticCount("async.started", { operation }, `async.started.${operation}`);
  const slowTimer = setTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    diagnosticEvent("async.pending", { operation, elapsedMs, slowMs }, "warn");
    try {
      options.onSlow?.(elapsedMs);
    } catch (error) {
      diagnosticEvent("async.slow-handler-failed", { operation, error }, "error");
    }
  }, slowMs);
  slowTimer.unref?.();
  try {
    const value = await run();
    diagnosticCount(
      "async.settled",
      { operation, durationMs: Date.now() - startedAt, outcome: "ok" },
      `async.settled.${operation}.ok`,
    );
    return value;
  } catch (error) {
    diagnosticEvent(
      "async.failed",
      { operation, durationMs: Date.now() - startedAt, error },
      "error",
    );
    throw error;
  } finally {
    clearTimeout(slowTimer);
  }
}
