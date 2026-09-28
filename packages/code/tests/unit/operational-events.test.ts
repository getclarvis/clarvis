import { expect, test } from "bun:test";
import {
  OPERATIONAL_EVENTS,
  invalidOperationalField,
  isOperationalPayload,
  type OperationalEvent,
} from "#src/core/operational-event-contract.ts";
import { emitOperationalEvent } from "#src/core/operational-diagnostics.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

function compileOnly(): void {
  // @ts-expect-error Unknown event names cannot use the typed emitter.
  emitOperationalEvent({ event: "unknown.event", details: {} });
  emitOperationalEvent({
    event: OPERATIONAL_EVENTS.appPainted,
    // @ts-expect-error A paint event cannot carry the catalog payload.
    details: { trigger: "catalog_surface" },
  });
}
void compileOnly;

const records: OperationalEvent[] = [
  { event: OPERATIONAL_EVENTS.shellPainted, details: { elapsed_ms: 1, mode: "run" } },
  {
    event: OPERATIONAL_EVENTS.appPainted,
    details: { elapsed_ms: 2, mode: "resume", deferred_catalog: true },
  },
  { event: OPERATIONAL_EVENTS.catalogLoadStarted, details: { trigger: "catalog_surface" } },
  {
    event: OPERATIONAL_EVENTS.markdownPreloadCompleted,
    details: { markdown: true, markdownInline: false, duration_ms: 3 },
  },
  { event: OPERATIONAL_EVENTS.updateCheckSkipped, details: { reason: "disabled" } },
  {
    event: OPERATIONAL_EVENTS.updateAvailable,
    details: { current_version: "1.0.0", available_version: "1.0.1", source: "cache" },
  },
];

test("operational payload guards validate every serialized field and permit enrichment", () => {
  for (const record of records) {
    expect(isOperationalPayload(record.event, record.details)).toBe(true);
    expect(isOperationalPayload(record.event, { ...record.details, enriched: "extra" })).toBe(true);
    for (const field of Object.keys(record.details)) {
      const without = { ...record.details } as Record<string, unknown>;
      delete without[field];
      expect(invalidOperationalField(record.event, without)).toBe(field);
    }
  }
  for (const reason of ["disabled", "source", "unmanaged", "unsupported"])
    expect(isOperationalPayload(OPERATIONAL_EVENTS.updateCheckSkipped, { reason })).toBe(true);
  for (const source of ["cache", "network"])
    expect(
      isOperationalPayload(OPERATIONAL_EVENTS.updateAvailable, {
        current_version: "1.0.0",
        available_version: "1.0.1",
        source,
      }),
    ).toBe(true);
  expect(invalidOperationalField(OPERATIONAL_EVENTS.appPainted, null)).toBe("details");
  expect(invalidOperationalField(OPERATIONAL_EVENTS.appPainted, [])).toBe("details");
  expect(invalidOperationalField(OPERATIONAL_EVENTS.appPainted, { elapsed_ms: -1 })).toBe(
    "elapsed_ms",
  );
  expect(invalidOperationalField(OPERATIONAL_EVENTS.appPainted, { elapsed_ms: Infinity })).toBe(
    "elapsed_ms",
  );
  expect(
    invalidOperationalField(OPERATIONAL_EVENTS.appPainted, {
      elapsed_ms: 1,
      mode: "run",
      deferred_catalog: "true",
    }),
  ).toBe("deferred_catalog");
  expect(isOperationalPayload(OPERATIONAL_EVENTS.updateCheckSkipped, { reason: "other" })).toBe(
    false,
  );
  expect(isOperationalPayload(OPERATIONAL_EVENTS.catalogLoadStarted, { trigger: "other" })).toBe(
    false,
  );
});

test("typed emission preserves names, payloads, levels and remains inert without a session", () => {
  emitOperationalEvent(records[0]!);
  const capture = recordDiagnostics();
  try {
    for (const record of records) emitOperationalEvent(record);
    expect(capture.records).toEqual([
      { event: "app.boot.shell-painted", details: { elapsed_ms: 1, mode: "run" }, level: "info" },
      {
        event: "app.boot.painted",
        details: { elapsed_ms: 2, mode: "resume", deferred_catalog: true },
        level: "info",
      },
      { event: "catalog.load.started", details: { trigger: "catalog_surface" }, level: "info" },
      {
        event: "markdown.preload.completed",
        details: { markdown: true, markdownInline: false, duration_ms: 3 },
        level: "debug",
      },
      { event: "update.check.skipped", details: { reason: "disabled" }, level: "debug" },
      {
        event: "update.available",
        details: { current_version: "1.0.0", available_version: "1.0.1", source: "cache" },
        level: "info",
      },
    ]);
  } finally {
    capture.uninstall();
  }
  emitOperationalEvent(records[0]!);
  expect(capture.records).toHaveLength(6);
});
