import { diagnosticEvent, type DiagnosticLevel } from "./diagnostic-events.ts";
import {
  OPERATIONAL_EVENTS,
  type OperationalEvent,
  type OperationalEventName,
} from "./operational-event-contract.ts";

const LEVELS = {
  [OPERATIONAL_EVENTS.shellPainted]: "info",
  [OPERATIONAL_EVENTS.appPainted]: "info",
  [OPERATIONAL_EVENTS.catalogLoadStarted]: "info",
  [OPERATIONAL_EVENTS.markdownPreloadCompleted]: "debug",
  [OPERATIONAL_EVENTS.updateCheckSkipped]: "debug",
  [OPERATIONAL_EVENTS.updateAvailable]: "info",
} as const satisfies Record<OperationalEventName, DiagnosticLevel>;

/** Emit smoke evidence through the existing optional diagnostic session. */
export function emitOperationalEvent(record: OperationalEvent): void {
  diagnosticEvent(record.event, record.details, LEVELS[record.event]);
}
