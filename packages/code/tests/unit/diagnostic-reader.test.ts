import { expect, test } from "bun:test";
import { OPERATIONAL_EVENTS } from "#src/core/operational-event-contract.ts";
import { selectDiagnosticEvent } from "../../tooling/artifact/diagnostic-reader.ts";

const file = "/fixture/code-debug-1.jsonl";
const line = (event: string, details: unknown): string => JSON.stringify({ event, details }) + "\n";

test("selects validated evidence while preserving absent and pending states", () => {
  expect(selectDiagnosticEvent("", file, OPERATIONAL_EVENTS.catalogLoadStarted)).toEqual({
    kind: "absent",
  });
  expect(
    selectDiagnosticEvent(
      line("other.event", { anything: true }),
      file,
      OPERATIONAL_EVENTS.catalogLoadStarted,
    ),
  ).toEqual({ kind: "absent" });
  const enriched = selectDiagnosticEvent(
    line("catalog.load.started", { trigger: "catalog_surface", enriched: 1 }),
    file,
    OPERATIONAL_EVENTS.catalogLoadStarted,
  );
  expect(enriched).toMatchObject({ kind: "found", details: { trigger: "catalog_surface" } });
  if (enriched.kind === "found") expect(Reflect.get(enriched.details, "enriched")).toBe(1);
  expect(
    selectDiagnosticEvent(
      '{"event":"catalog.load.started"',
      file,
      OPERATIONAL_EVENTS.catalogLoadStarted,
    ),
  ).toEqual({
    kind: "pending",
    file,
  });
  expect(
    selectDiagnosticEvent(
      line("other.event", {}) + "{",
      file,
      OPERATIONAL_EVENTS.catalogLoadStarted,
    ),
  ).toEqual({ kind: "pending", file });
});

test("rejects completed malformed JSON and non-object records", () => {
  for (const content of ["{\n", "null\n", "[]\n", "42\n"]) {
    const result = selectDiagnosticEvent(content, file, OPERATIONAL_EVENTS.appPainted);
    expect(result).toMatchObject({ kind: "invalid", file, event: "<jsonl>" });
  }
  expect(selectDiagnosticEvent('{"details":{}}\n', file, OPERATIONAL_EVENTS.appPainted)).toEqual({
    kind: "invalid",
    file,
    event: "<jsonl>",
    field: "event",
  });
});

test("invalid known catalog evidence cannot be mistaken for absence", () => {
  expect(
    selectDiagnosticEvent(
      line("catalog.load.started", { trigger: "wrong" }),
      file,
      OPERATIONAL_EVENTS.appPainted,
    ),
  ).toEqual({ kind: "invalid", file, event: "catalog.load.started", field: "trigger" });
  expect(
    selectDiagnosticEvent(
      line("app.boot.painted", { elapsed_ms: 1, mode: "run", deferred_catalog: "true" }),
      file,
      OPERATIONAL_EVENTS.appPainted,
    ),
  ).toEqual({ kind: "invalid", file, event: "app.boot.painted", field: "deferred_catalog" });
  expect(
    selectDiagnosticEvent(
      line("app.boot.painted", { elapsed_ms: 1, mode: "run", deferred_catalog: true }) + "{\n",
      file,
      OPERATIONAL_EVENTS.appPainted,
    ),
  ).toEqual({ kind: "invalid", file, event: "<jsonl>", field: "line" });
});
