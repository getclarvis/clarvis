import type { RunEvent } from "@clarvis/protocol";
import { applyEvent, type SpanSink } from "../../src/adapters/store.ts";
import type { EventSource } from "../../src/adapters/event-span.ts";

/** Preserve the precise event member while checking every fixture against the wire contract. */
export function runEvent<const T extends RunEvent>(event: T): T {
  return event;
}

/** Drive the code-owned projection directly from the protocol seam it consumes. */
export function applyRunEvent(sink: SpanSink, event: RunEvent, source: EventSource): void {
  applyEvent(sink, event, source);
}

/** Apply a complete protocol stream in order. */
export function applyRunEvents(
  sink: SpanSink,
  events: readonly RunEvent[],
  source: EventSource,
): void {
  for (const event of events) applyRunEvent(sink, event, source);
}
