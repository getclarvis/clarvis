import {
  installDiagnosticSession,
  type DiagnosticDetails,
  type DiagnosticLevel,
  type DiagnosticSession,
} from "../../src/core/diagnostic-events.ts";

/** One record a {@link recordDiagnostics} session captured. */
export interface RecordedDiagnostic {
  event: string;
  details: DiagnosticDetails;
  level?: DiagnosticLevel;
}

/** A captured diagnostic stream plus the uninstall its test must call. */
export interface DiagnosticRecording {
  records: RecordedDiagnostic[];
  /** The records whose event name is exactly `event`. */
  of: (event: string) => RecordedDiagnostic[];
  /** The first record named `event`, or `undefined`. */
  first: (event: string) => RecordedDiagnostic | undefined;
  uninstall: () => void;
}

/**
 * Install an in-memory diagnostic session for the duration of one test.
 *
 * @returns the recording; the caller must call `uninstall()`, normally from an
 *   `afterEach`.
 * @remarks Nothing installs a session under `bun test`, so every call site in
 *   `src/` is inert by default and a test that wants to assert on one has to
 *   opt in here. The fake is complete rather than partial for the reason
 *   `specs/cross-cutting/observability.md` §5 gives: a session missing a member throws the
 *   moment new code reaches it, several packages away from the change.
 */
export function recordDiagnostics(): DiagnosticRecording {
  const records: RecordedDiagnostic[] = [];
  const session: DiagnosticSession = {
    path: "/dev/null",
    level: "debug",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    setLevel: () => {},
    bind: () => {},
    event: (event, details = {}, level) => {
      records.push({ event, details, ...(level === undefined ? {} : { level }) });
    },
    count: (event, details = {}) => {
      records.push({ event, details });
    },
    close: () => {},
  };
  return {
    records,
    of: (event) => records.filter((record) => record.event === event),
    first: (event) => records.find((record) => record.event === event),
    uninstall: installDiagnosticSession(session),
  };
}
