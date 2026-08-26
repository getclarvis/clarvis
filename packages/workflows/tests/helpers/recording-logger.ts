import type { Logger } from "@clarvis/capability";

/** One record a {@link RecordingLogger} captured, with its inherited bindings. */
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
  /** The single record carrying `event`; throws unless there is exactly one. */
  one: (event: string) => LoggedRecord;
  events: () => string[];
}

/**
 * Build a recording logger that implements `child`.
 *
 * @param level - the level to report, so `levelEnabled` guards are exercised.
 *   Omitted means the logger reports none, which `levelEnabled` treats as
 *   emitting everything.
 * @returns the logger and the assertions over what it received.
 * @remarks Unlike the minimal fakes elsewhere in the repo this one folds a
 *   child's bindings into every record, because correlation is the property
 *   under test here: a fan-out is only readable as one tree if `workflow_id`,
 *   `dispatch_id`, `round_id` and `unit_key` survive the `bind` chain.
 */
export function recordingLogger(level?: string): RecordingLogger {
  const records: LoggedRecord[] = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const capture =
      (levelName: LoggedRecord["level"]) =>
      (fields: unknown, message?: unknown): void => {
        const bag = { ...bindings, ...((fields ?? {}) as Record<string, unknown>) };
        records.push({
          level: levelName,
          event: typeof bag.event === "string" ? bag.event : "",
          fields: bag,
          message: typeof message === "string" ? message : "",
        });
      };
    return {
      debug: capture("debug"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
      child: (extra: Record<string, unknown>): Logger => make({ ...bindings, ...extra }),
      ...(level === undefined ? {} : { level }),
    } as unknown as Logger;
  };
  const of = (event: string): LoggedRecord[] => records.filter((r) => r.event === event);
  return {
    logger: make({}),
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
