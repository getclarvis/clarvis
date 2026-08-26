import type { LogFn, Logger } from "@clarvis/capability";

export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

export interface RecordingLogger {
  logger: Logger;
  records: LogRecord[];
  /** Every record whose `event` field matches, newest last. */
  events(name: string): LogRecord[];
}

/**
 * A `Logger` that keeps every record, for asserting on the fields a call site emits.
 *
 * @param level - reported as the logger's own level; omit it so `levelEnabled`
 *   treats the logger as emitting everything.
 */
export function recordingLogger(level?: string): RecordingLogger {
  const records: LogRecord[] = [];
  const at = (name: LogRecord["level"]): LogFn => {
    const fn = (obj: unknown, msg?: unknown): void => {
      if (typeof obj === "string") {
        records.push({ level: name, fields: {}, message: obj });
        return;
      }
      records.push({
        level: name,
        fields: (obj ?? {}) as Record<string, unknown>,
        message: typeof msg === "string" ? msg : "",
      });
    };
    return fn as LogFn;
  };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    ...(level === undefined ? {} : { level }),
  };
  return {
    logger,
    records,
    events: (name) => records.filter((record) => record.fields["event"] === name),
  };
}
