import { describe, expect, it } from "bun:test";
import {
  buildDelegateTaskPlanAugmentation,
  duplicateBatchTaskId,
  PENDING_TASKS_NOTE,
  planReviewUnplannedBlock,
} from "../../src/capability/messages.ts";

describe("planReviewUnplannedBlock", () => {
  it("names the refused tool and points at create_plan and the read-only tools", () => {
    const text = planReviewUnplannedBlock("write_file");
    expect(text).toContain("'write_file'");
    expect(text).toContain("no plan exists yet");
    expect(text).toContain("create_plan");
    expect(text).toContain("available read-only tools");
    expect(text).toContain("ask_user");
  });

  it("changes only the named tool between calls", () => {
    expect(planReviewUnplannedBlock("shell")).toContain("'shell'");
    expect(planReviewUnplannedBlock("shell")).not.toContain("'write_file'");
  });

  it("does not duplicate a coding-tool catalogue it cannot derive", () => {
    const text = planReviewUnplannedBlock("write_file");
    for (const removed of ["outline", "check_syntax", "read_file", "read_files", "grep"]) {
      expect(text, removed).not.toContain(removed);
    }
  });
});

describe("PENDING_TASKS_NOTE", () => {
  it("lists open ids without confusing delegation with task closure", () => {
    const text = PENDING_TASKS_NOTE(["t1", "t2"]);
    expect(text).toContain("2 plan task(s)");
    expect(text).toContain("t1, t2");
    expect(text).toContain("transition_plan_task");
    expect(text).toContain("delegate_task");
    expect(text).toContain("Do NOT finalize yet");
    expect(text).toContain("returned/failed states do not close tasks");
    expect(text).toContain("done requires an observed result");
    expect(text).toContain("Do not invent success or abandon needed work");
  });

  it("reports the count for a single open task", () => {
    expect(PENDING_TASKS_NOTE(["only"])).toContain("1 plan task(s)");
  });
});

describe("duplicateBatchTaskId", () => {
  it("names the duplicated id and explains the one-per-iteration rule", () => {
    const text = duplicateBatchTaskId("t7");
    expect(text).toContain("duplicate task_id 't7'");
    expect(text).toContain("only one Sub-agent per task_id per iteration");
  });
});

describe("buildDelegateTaskPlanAugmentation", () => {
  it("under plan_review, states the review contract and exempts pre-plan exploration", () => {
    const augmentation = buildDelegateTaskPlanAugmentation(true);
    expect(augmentation.description).toContain("requires human plan review");
    expect(augmentation.description).toContain("Use spawn_subagent for pre-plan exploration");
    expect(augmentation.description).toContain("delegate_task remains reserved");
    expect(augmentation.properties).toHaveProperty("task_id");
  });

  it("without review, carries the plain description and no review wording", () => {
    const augmentation = buildDelegateTaskPlanAugmentation(false);
    expect(augmentation.description).not.toContain("requires human plan review");
    expect(augmentation.description).toContain("Delegate one existing plan task");
    expect(augmentation.description).toContain("task_id is required");
    expect(augmentation.description).toContain("Use spawn_subagent instead for independent work");
    expect(augmentation.properties).toHaveProperty("task_id");
    expect(augmentation.description).toContain("returned, not done");
    expect(augmentation.properties.task_id).toMatchObject({
      description: expect.stringContaining("REQUIRED"),
    });
  });
});
