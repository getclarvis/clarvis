import { describe, expect, it } from "bun:test";

import { parsePlan } from "../../src/format.ts";
import { boundedPlanReason, MAX_PLAN_LOG_REASON_CHARS } from "../../src/log.ts";

describe("boundedPlanReason", () => {
  it("collapses a parser's quoted excerpt onto one line", () => {
    const body = "confidential-plan-text ".repeat(60);
    let thrown: unknown;
    try {
      parsePlan(`---\nid: p\n\t${body}\n---\n\n## Objective\n\nx\n`, "p.md");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain("\n");

    const reason = boundedPlanReason(thrown);
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\r");
    expect(reason.length).toBeLessThanOrEqual(MAX_PLAN_LOG_REASON_CHARS);
    expect(reason).toStartWith("Tabs are not allowed as indentation");
  });

  it("bounds a plan body a format error interpolated whole", () => {
    const reason = boundedPlanReason(
      new Error(`Invalid plan Markdown task line: ${"plan body ".repeat(400)}`),
    );
    expect(reason.length).toBe(MAX_PLAN_LOG_REASON_CHARS);
    expect(reason).toEndWith("…");
  });

  it("redacts a key-shaped string and accepts a non-Error throw", () => {
    expect(boundedPlanReason(`token sk-${"a".repeat(48)} rejected`)).not.toContain("a".repeat(48));
    expect(boundedPlanReason("plain refusal")).toBe("plain refusal");
  });
});
