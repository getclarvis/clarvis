import { NOOP_LOGGER, type Logger, type LogLevel } from "@clarvis/capability";

export interface LogRecord {
  level: Exclude<LogLevel, "silent">;
  message: string;
  fields: Record<string, unknown>;
}

export interface RecordingLogger extends Logger {
  readonly records: LogRecord[];
  events(name: string): Record<string, unknown>[];
}

/**
 * A `Logger` that keeps every record, for asserting the observability contract.
 *
 * Built by spreading {@link NOOP_LOGGER}, never as a bare `{ warn }`: a partial
 * fake throws the moment code reaches a level it did not implement, which is
 * how a kernel integration test died on a `debug` added several packages away.
 * Its `child` folds bindings into the same array, so a correlated record is
 * asserted exactly as an operator would read it.
 */
export function recordingLogger(level: LogLevel = "debug"): RecordingLogger {
  const records: LogRecord[] = [];
  const at =
    (severity: Exclude<LogLevel, "silent">, bindings: Record<string, unknown>) =>
    (obj: unknown, ...rest: unknown[]): void => {
      const msg = typeof rest[0] === "string" ? rest[0] : undefined;
      if (typeof obj === "string") {
        records.push({ level: severity, message: obj, fields: { ...bindings } });
        return;
      }
      records.push({
        level: severity,
        message: msg ?? "",
        fields: { ...bindings, ...((obj ?? {}) as Record<string, unknown>) },
      });
    };
  const build = (bindings: Record<string, unknown>): RecordingLogger => ({
    ...NOOP_LOGGER,
    debug: at("debug", bindings),
    info: at("info", bindings),
    warn: at("warn", bindings),
    error: at("error", bindings),
    level,
    records,
    events: (name) =>
      records.filter((record) => record.fields.event === name).map((record) => record.fields),
    child: (extra) => build({ ...bindings, ...extra }),
  });
  return build({});
}
