import { describe, expect, it } from "bun:test";
import { GoalError } from "@clarvis/goal";
import { z } from "zod";
import { kernelError } from "../../src/core/errors.ts";
import { toGoalKernelError } from "../../src/goals/errors.ts";

describe("goal error projection", () => {
  it.each([
    ["blocked", "conflict"],
    ["budget_limited", "resource_exhausted"],
    ["usage_limited", "resource_exhausted"],
    ["resource_exhausted", "resource_exhausted"],
    ["conflict", "conflict"],
    ["not_found", "not_found"],
    ["invalid_request", "invalid_request"],
  ] as const)("maps %s to %s without private exception material", (domain, code) => {
    const projected = toGoalKernelError(new GoalError(domain, "private-objective-path"));
    expect(projected.code).toBe(code);
    expect(projected.message).not.toContain("private-objective-path");
    expect(JSON.stringify(projected)).not.toContain("private-objective-path");
  });

  it("distinguishes schema, storage and already normalized host errors", () => {
    const schema = z.literal("expected").safeParse("private-input");
    expect(toGoalKernelError(schema.error)).toMatchObject({
      code: "invalid_request",
      message: "Invalid goal control arguments",
    });
    expect(toGoalKernelError(new Error("private-storage"))).toMatchObject({
      code: "internal",
      message: "Goal state operation failed",
    });
    const normalized = kernelError("cancelled", "Goal execution was cancelled");
    expect(toGoalKernelError(normalized)).toBe(normalized);
  });
});
