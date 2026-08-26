import { describe, expect, test } from "bun:test";

import { buildPyramidGate, createTouchedLedger, pyramidIssue } from "../../src/indexer/pyramid.ts";

describe("memory pyramid closure", () => {
  test("an empty ledger fast-accepts and passes", async () => {
    const ledger = createTouchedLedger();
    const gate = buildPyramidGate(ledger);

    expect(ledger.isEmpty()).toBeTrue();
    expect(gate.fastAcceptOk?.()).toBeTrue();
    expect(await gate.check({ mode: "text", text: "done" })).toEqual({ kind: "pass" });
  });

  test("names each missing layer before accepting a closed deep leaf", async () => {
    expect(pyramidIssue([{ tool: "edit_memory", path: "PROFILE.md" }])).toContain(
      "only compiled layers",
    );
    expect(pyramidIssue([{ tool: "write_memory", path: "infra/bun/MEMORY.md" }])).toContain(
      "PROFILE.md",
    );
    expect(
      pyramidIssue([
        { tool: "write_memory", path: "infra/bun/runtime/MEMORY.md" },
        { tool: "edit_memory", path: "PROFILE.md" },
      ]),
    ).toContain("infra/TOPIC.md");

    const closed = [
      { tool: "write_memory" as const, path: "infra/bun/runtime/MEMORY.md" },
      { tool: "edit_memory" as const, path: "infra/TOPIC.md" },
      { tool: "edit_memory" as const, path: "infra/bun/TOPIC.md" },
      { tool: "edit_memory" as const, path: "PROFILE.md" },
    ];
    expect(pyramidIssue(closed)).toBeNull();

    const ledger = createTouchedLedger();
    for (const mutation of closed.slice(0, 1)) ledger.record(mutation);
    const outcome = await buildPyramidGate(ledger).check({ mode: "text", text: "done" });
    expect(outcome.kind).toBe("nudge");
    expect((outcome as { note: string }).note).toContain("memory pyramid is not closed");
  });

  test("a deletion does not count as compiling an ancestor", () => {
    expect(
      pyramidIssue([
        { tool: "delete_memory", path: "infra/bun/MEMORY.md" },
        { tool: "delete_memory", path: "PROFILE.md" },
      ]),
    ).toContain("PROFILE.md");
  });
});
