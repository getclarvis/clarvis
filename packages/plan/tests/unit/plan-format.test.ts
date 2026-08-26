import { describe, expect, test } from "bun:test";
import { parsePlan, planFilename, renderPlan, transitionTask } from "../../src/index.ts";
import { createMemoryPlanStore } from "../helpers/store.ts";

describe("plan format", () => {
  test("uses Windows-safe filenames", () => {
    expect(planFilename(new Date("2026-07-25T12:34:56Z"), "Ship the Plan!")).toBe(
      "2026-07-25T12-34-56-ship-the-plan.md",
    );
  });

  test("round-trips deterministically and preserves uncontrolled content", async () => {
    const store = createMemoryPlanStore();
    const created = await store.create({
      title: "Test plan",
      objective: "Deliver it.",
      context: "Preserve this.",
      tasks: [{ title: "Implement", detail: "Carefully", exit: "Tests pass" }],
      validation: ["bun test"],
      createdByRun: "run-1",
      now: new Date("2026-07-25T12:34:56Z"),
    });
    const source = renderPlan(created);
    const edited = source
      .replace("created_by_run: run-1", "created_by_run: run-1\nowner_note: hello")
      .concat("\n## Appendix\n\nHuman prose.\n");
    const parsed = parsePlan(edited, created.path);
    expect(parsed.unknown_frontmatter.owner_note).toBe("hello");
    expect(parsed.extra_sections.Appendix).toBe("Human prose.");
    expect(renderPlan(parsePlan(renderPlan(parsed), created.path))).toBe(renderPlan(parsed));
  });

  test("round-trips multi-line task fields and prose headings instead of bricking the file", async () => {
    const store = createMemoryPlanStore();
    const created = await store.create({
      title: "Multi-line",
      objective: "First paragraph.\n## Design notes\nStill the objective.",
      tasks: [{ title: "Run the migration" }],
      validation: ["tests pass"],
      createdByRun: "run-1",
    });
    const active = await store.update(created.id, created, (plan) => {
      plan.tasks[0] = transitionTask(plan.tasks[0]!, "in_progress");
    });
    const error =
      "Error: connection refused\n    at db.connect (db.ts:42)\n\n    at main (index.ts:10)";
    const failed = await store.update(active.id, active, (plan) => {
      plan.tasks[0] = transitionTask(plan.tasks[0]!, "failed", { error });
    });

    const reread = await store.read(failed.id);
    expect(reread.tasks[0]?.error).toBe(error);
    expect(reread.objective).toBe("First paragraph.\n## Design notes\nStill the objective.");
    expect(renderPlan(parsePlan(renderPlan(reread), reread.path))).toBe(renderPlan(reread));
  });

  test("rejects blank/multi-line task titles and multi-line validation items", async () => {
    const store = createMemoryPlanStore();
    await expect(
      store.create({
        title: "Bad",
        objective: "o",
        tasks: [{ title: "line 1\nline 2" }],
        createdByRun: "run-1",
      }),
    ).rejects.toBeTruthy();
    await expect(
      store.create({
        title: "Bad",
        objective: "o",
        tasks: [{ title: "   " }],
        createdByRun: "run-1",
      }),
    ).rejects.toBeTruthy();
    await expect(
      store.create({
        title: "Bad",
        objective: "o",
        tasks: [{ title: "One" }],
        validation: ["multi\nline"],
        createdByRun: "run-1",
      }),
    ).rejects.toBeTruthy();
  });
});
