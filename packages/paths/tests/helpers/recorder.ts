import type { PathsLogger } from "@clarvis/paths";

export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

export interface Recorder {
  logger: PathsLogger;
  records: LogRecord[];
  events(name: string): Record<string, unknown>[];
}

/** A {@link PathsLogger} that keeps every record, for asserting on events. */
export function recorder(): Recorder {
  const records: LogRecord[] = [];
  const at =
    (level: LogRecord["level"]) =>
    (fields: Record<string, unknown>, msg: string): void => {
      records.push({ level, fields, msg });
    };
  return {
    records,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    events: (name: string) => records.filter((r) => r.fields.event === name).map((r) => r.fields),
  };
}
