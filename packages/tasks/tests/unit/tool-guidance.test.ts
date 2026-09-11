import { describe, expect, test } from "bun:test";
import { TASK_TOOLS, taskToolInputSchemas } from "../../src/toolset.ts";

describe("external task model guidance", () => {
  test("exposes the review evidence requirement enforced by the validator", () => {
    const schema = taskToolInputSchemas.submit_task_for_review;
    expect(schema.safeParse({ summary: "Completed the scoped change" }).success).toBe(false);
    for (const detail of [
      { evidence: ["package test passed"] },
      { no_evidence_reason: "The provider has no evidence for this administrative change" },
    ]) {
      expect(schema.safeParse({ summary: "Completed", ...detail }).success).toBe(true);
    }
    expect(TASK_TOOLS.submit_task_for_review.description).toContain(
      "at least one evidence item or artifact, or no_evidence_reason",
    );
    const properties = TASK_TOOLS.submit_task_for_review.inputSchema.properties as Record<
      string,
      { description: string }
    >;
    expect(properties.allow_without_artifacts!.description).toContain("request human approval");
    expect(properties.allow_without_artifacts!.description).toContain("Does not bypass conflicts");
  });

  test("distinguishes provider task ids from plan task ids", () => {
    const properties = TASK_TOOLS.read_task.inputSchema.properties as Record<
      string,
      { description: string }
    >;
    expect(properties.id!.description).toContain("not a plan task_id");
    expect(TASK_TOOLS.assign_task.description).toContain("assignee_id:null unassigns");
    expect(TASK_TOOLS.complete_task.description).toContain("never calls this automatically");
  });
});
