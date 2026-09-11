import { describe, expect, it } from "bun:test";
import { checkpointMetadataSchema } from "../../src/finalization.ts";

describe("checkpoint metadata", () => {
  it("keeps a bounded handoff separate from any final output schema", () => {
    const handoff = { summary: "s".repeat(4096), next_step: "n".repeat(4096) };
    expect(checkpointMetadataSchema.parse(handoff)).toEqual(handoff);
  });

  it.each([
    {},
    null,
    { summary: "", next_step: "continue" },
    { summary: "stage", next_step: "   " },
    { summary: "s".repeat(4097), next_step: "continue" },
    { summary: "stage", next_step: "n".repeat(4097) },
    { summary: "stage", next_step: "continue", result: "invented final" },
  ])("rejects an invalid handoff %j", (value) => {
    expect(checkpointMetadataSchema.safeParse(value).success).toBe(false);
  });
});
