import { describe, expect, it } from "bun:test";
import { mapExecutionRuleWriteError } from "#src/config/execution-rule-errors.ts";
import { KernelException } from "#src/core/errors.ts";
import { ExecutionRuleWriteError } from "#src/execution/execpolicy-errors.ts";

describe("mapExecutionRuleWriteError", () => {
  for (const reason of ["busy", "revision_changed"] as const) {
    it(`maps ${reason} by cause regardless of message or name`, () => {
      const error = new ExecutionRuleWriteError(reason, "unrelated presentation");
      error.name = "AnotherName";
      const mapped = mapExecutionRuleWriteError(error);
      expect(mapped).toBeInstanceOf(KernelException);
      expect(mapped).toMatchObject({
        code: "conflict",
        message: "AnotherName: unrelated presentation",
      });
    });
  }

  it("preserves lookalike messages and objects by identity", () => {
    const errors = [
      new Error("execution rules changed before save"),
      new Error("execution rules are busy"),
      { reason: "busy" },
    ];
    for (const error of errors) expect(mapExecutionRuleWriteError(error)).toBe(error);
  });

  it("preserves existing kernel errors and non-Error throws by identity", () => {
    const values = [new KernelException("invalid_request", "bad document"), "are busy", null, 42];
    for (const value of values) expect(mapExecutionRuleWriteError(value)).toBe(value);
  });
});
