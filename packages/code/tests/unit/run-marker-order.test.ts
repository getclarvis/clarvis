import { expect, test } from "bun:test";
import { TranscriptRows } from "../../src/core/transcript/rows.ts";

test("new authoritative rows insert before a known outcome without reordering known owners", () => {
  const rows = new TranscriptRows();
  for (const id of ["tool", "outcome"])
    rows.admit({ id, kind: "part", projection: "lead", scope: "run" });
  const tool = rows.row("tool");
  const outcome = rows.row("outcome");
  rows.admit({
    id: "recovered",
    kind: "part",
    projection: "lead",
    scope: "run",
    before: "outcome",
  });
  expect(rows.select("lead")).toEqual(["tool", "recovered", "outcome"]);
  expect(rows.row("tool")).toBe(tool);
  expect(rows.row("outcome")).toBe(outcome);
  rows.admit({ id: "tool", kind: "part", projection: "lead", scope: "run", before: "recovered" });
  expect(rows.select("lead")).toEqual(["tool", "recovered", "outcome"]);
});
test("a hidden run boundary is admitted exactly once after host completion", () => {
  const rows = new TranscriptRows();
  rows.admit({ id: "run", kind: "boundary", projection: "lead", scope: "run" });
  rows.admit({ id: "answer", kind: "part", projection: "lead", scope: "run" });
  rows.admit({ id: "run", kind: "part", projection: "lead", scope: "run" });
  rows.admit({ id: "run", kind: "part", projection: "lead", scope: "run" });
  expect(rows.select("lead")).toEqual(["answer", "run"]);
});
