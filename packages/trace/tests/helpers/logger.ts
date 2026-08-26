import type { Logger, LogLevel } from "@clarvis/capability";

/** One record a {@link recordingLogger} captured. */
export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

/**
 * A {@link Logger} that keeps every record it is handed.
 *
 * @param records - the array records are appended to.
 * @param level - the level the logger reports, for a `levelEnabled` guard.
 * @returns the capturing logger.
 * @remarks Reporting no level by default is deliberate: `levelEnabled` treats an
 * unknown level as emitting, so a guarded site is exercised rather than skipped.
 */
export function recordingLogger(records: LogRecord[], level?: LogLevel): Logger {
  const at =
    (at: LogRecord["level"]) =>
    (...args: unknown[]): void => {
      records.push({
        level: at,
        fields: (args[0] ?? {}) as Record<string, unknown>,
        message: typeof args[1] === "string" ? args[1] : "",
      });
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    ...(level !== undefined ? { level } : {}),
  };
}

/** Every record carrying `event`, in emission order. */
export function eventsNamed(records: readonly LogRecord[], event: string): LogRecord[] {
  return records.filter((r) => r.fields.event === event);
}

/** The single record carrying `event`; throws when there is not exactly one. */
export function oneEvent(records: readonly LogRecord[], event: string): LogRecord {
  const matches = eventsNamed(records, event);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one '${event}' record, saw ${String(matches.length)}`);
  }
  return matches[0]!;
}
