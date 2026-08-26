import { describe, expect, it } from "bun:test";
import { mapError } from "../../src/mcp/errors.ts";

describe("mapError", () => {
  it("preserves resource exhaustion instead of degrading capacity failures to internal", () => {
    expect(mapError({ code: "resource_exhausted", message: "capacity is full" })).toEqual({
      code: "resource_exhausted",
      message: "capacity is full",
    });
  });

  it("preserves every protocol lifecycle code the facade may relay", () => {
    for (const code of ["cancelled", "unsupported", "continuation_unavailable"] as const) {
      expect(mapError({ code, message: code })).toEqual({ code, message: code });
    }
  });
});
