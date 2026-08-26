import type { Logger } from "@clarvis/capability";

/** One record a {@link RecordingLogger} captured. */
export interface LoggedRecord {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
  message: string;
}

/** A {@link Logger} that keeps what it was told, for asserting on it. */
export interface RecordingLogger {
  logger: Logger;
  records: LoggedRecord[];
  /** Every record carrying `event`, in emission order. */
  of: (event: string) => LoggedRecord[];
  /** The single record carrying `event`; fails the caller's expectation if not exactly one. */
  one: (event: string) => LoggedRecord;
  events: () => string[];
}

/**
 * Build a recording logger.
 *
 * @param level - the level to report, so `levelEnabled` guards can be exercised.
 *   Omitted means the logger reports none, which `levelEnabled` treats as
 *   emitting everything.
 * @returns the logger and the assertions over what it received.
 */
export function recordingLogger(level?: string): RecordingLogger {
  const records: LoggedRecord[] = [];
  const capture =
    (levelName: LoggedRecord["level"]) =>
    (fields: unknown, message?: unknown): void => {
      const bag = (fields ?? {}) as Record<string, unknown>;
      records.push({
        level: levelName,
        event: typeof bag.event === "string" ? bag.event : "",
        fields: bag,
        message: typeof message === "string" ? message : "",
      });
    };
  const logger = {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    ...(level !== undefined ? { level } : {}),
  } as unknown as Logger;
  const of = (event: string): LoggedRecord[] => records.filter((r) => r.event === event);
  return {
    logger,
    records,
    of,
    one: (event: string): LoggedRecord => {
      const found = of(event);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one ${event} record, got ${String(found.length)} of [${records
            .map((r) => r.event)
            .join(", ")}]`,
        );
      }
      return found[0]!;
    },
    events: (): string[] => records.map((r) => r.event),
  };
}
