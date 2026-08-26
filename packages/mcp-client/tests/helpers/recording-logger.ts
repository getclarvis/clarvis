import type { Logger, LogLevel } from "@clarvis/capability";

/** One record a package under test wrote through the `Logger` port. */
export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

/** A `Logger` that keeps every record, with `child` bindings already merged. */
export interface RecordingLogger {
  logger: Logger;
  records: LogRecord[];
  /** Every record carrying `event`, oldest first. */
  all(event: string): LogRecord[];
  /** The first record carrying `event`. */
  first(event: string): LogRecord | undefined;
  /** Every record's `event` field, in order. */
  events(): unknown[];
}

/**
 * Build a recording `Logger` at `level`.
 *
 * @param level - the level the logger reports, which is what `levelEnabled`
 *   guards read; `debug` records everything.
 * @returns the logger and the records written through it.
 * @remarks `child` merges rather than replacing, so a test sees exactly the
 *   fields a real backend would stamp — which is the only way to assert that a
 *   package bound `mcp` and `connection_id` instead of spelling them per line.
 */
export function createRecordingLogger(level: LogLevel = "debug"): RecordingLogger {
  const records: LogRecord[] = [];

  const make = (bindings: Record<string, unknown>): Logger => {
    const write =
      (at: LogRecord["level"]) =>
      (fields: unknown, message?: unknown): void => {
        records.push({
          level: at,
          fields: { ...bindings, ...(fields as Record<string, unknown>) },
          message: typeof message === "string" ? message : "",
        });
      };
    return {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      child: (extra: Record<string, unknown>) => make({ ...bindings, ...extra }),
      level,
    };
  };

  return {
    logger: make({}),
    records,
    all: (event: string) => records.filter((record) => record.fields.event === event),
    first: (event: string) => records.find((record) => record.fields.event === event),
    events: () => records.map((record) => record.fields.event),
  };
}
