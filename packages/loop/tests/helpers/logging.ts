import type { Logger, LogFn, LogLevel } from "@clarvis/capability";

/** One record a {@link RecordingLogger} captured. */
export interface LogRecord {
  level: Exclude<LogLevel, "silent">;
  fields: Record<string, unknown>;
  message: string;
}

/** A {@link Logger} that keeps everything it was told, for assertions. */
export interface RecordingLogger extends Logger {
  readonly records: LogRecord[];
  /** Every record carrying `event`. */
  of(event: string): LogRecord[];
}

/**
 * Build a {@link Logger} that records instead of writing.
 *
 * @param level - the level it reports through the port's optional `level`
 *   member, so `levelEnabled` guards can be exercised; omit for a logger that
 *   reports none, which every guard treats as emitting.
 * @returns the recorder; it implements `child` by merging bindings, so `bind`
 *   correlation is captured on the record rather than discarded.
 */
export function recordingLogger(level?: LogLevel): RecordingLogger {
  const records: LogRecord[] = [];
  const make = (bindings: Record<string, unknown>): RecordingLogger => {
    const write =
      (at: Exclude<LogLevel, "silent">): LogFn =>
      (first: unknown, ...rest: unknown[]): void => {
        const structured = typeof first === "object" && first !== null;
        const message = structured ? rest[0] : first;
        records.push({
          level: at,
          fields: { ...bindings, ...(structured ? (first as Record<string, unknown>) : {}) },
          message: typeof message === "string" ? message : "",
        });
      };
    const logger: RecordingLogger = {
      records,
      of: (event: string) => records.filter((record) => record.fields.event === event),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      child: (extra: Record<string, unknown>) => make({ ...bindings, ...extra }),
      ...(level !== undefined ? { level } : {}),
    };
    return logger;
  };
  return make({});
}
