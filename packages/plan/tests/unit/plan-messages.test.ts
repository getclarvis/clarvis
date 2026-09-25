import { describe, expect, it } from "bun:test";
import { PENDING_TASKS_NOTE, planReviewUnplannedBlock } from "../../src/capability/messages.ts";

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
    for (const removed of ["outline", "check_syntax", "read_file", "read_image"]) {
      expect(text, removed).not.toContain(removed);
    }
  });
});

describe("PENDING_TASKS_NOTE", () => {
  it("lists open ids and directs completion through task transitions", () => {
    const text = PENDING_TASKS_NOTE(["t1", "t2"]);
    expect(text).toContain("2 plan task(s)");
    expect(text).toContain("t1, t2");
    expect(text).toContain("transition_plan_task");
    expect(text).toContain("Do NOT finalize yet");
    expect(text).toContain("done requires an observed result");
    expect(text).toContain("Do not invent success or abandon needed work");
  });

  it("reports the count for a single open task", () => {
    expect(PENDING_TASKS_NOTE(["only"])).toContain("1 plan task(s)");
  });
});
