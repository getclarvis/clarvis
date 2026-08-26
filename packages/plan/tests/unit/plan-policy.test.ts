import { describe, expect, test } from "bun:test";
import {
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_TASKS,
  applyPlanRevision,
  applyPlanRevisions,
  allowedTaskTransitions,
  isPlanSealed,
  isTaskClosed,
  newPlan,
  parsePlan,
  revisePlanInputSchema,
  transitionTask,
} from "../../src/index.ts";

describe("task transitions", () => {
  test("enforces the transition matrix and required outcomes", () => {
    expect(allowedTaskTransitions("pending")).toEqual(["in_progress", "done", "abandoned"]);
    expect(() => transitionTask({ id: "t1", title: "One", status: "pending" }, "done")).toThrow(
      "requires result",
    );
    expect(
      transitionTask({ id: "t1", title: "One", status: "pending" }, "done", {
        result: "Shipped",
      }).status,
    ).toBe("done");
  });
});

describe("plan revisions", () => {
  test("allocates stable task ids and rejects self-reordering", () => {
    const document = parsePlan(`---
id: p
title: P
status: active
retention: keep
revision: 1
spec_revision: 1
created_at: 2026-07-25T12:34:56.000Z
updated_at: 2026-07-25T12:34:56.000Z
created_by_run: run-1
---

## Objective

Ship

## Context


## Tasks

- [ ] (t1) One
- [x] (t3) Three
  - Result: done

## Validation


## Notes

`);
    const added = applyPlanRevision(document, {
      type: "add_task",
      task: { title: "Four" },
    }).document;
    expect(added.tasks.at(-1)?.id).toBe("t4");
    expect(() =>
      applyPlanRevision(added, {
        type: "reorder_task",
        task_id: "t1",
        after_task_id: "t1",
      }),
    ).toThrow("after itself");
  });
});

describe("a sealed plan", () => {
  test("only `completed` seals; `cancelled` and `failed` describe work that stopped", () => {
    expect(isPlanSealed({ status: "completed" })).toBeTrue();
    expect(isPlanSealed({ status: "cancelled" })).toBeFalse();
    expect(isPlanSealed({ status: "failed" })).toBeFalse();
    expect(isPlanSealed({ status: "active" })).toBeFalse();
    expect(isPlanSealed({ status: "awaiting_approval" })).toBeFalse();
  });

  test("`failed` is not a closed task status — it still has somewhere to go", () => {
    expect(isTaskClosed("done")).toBeTrue();
    expect(isTaskClosed("abandoned")).toBeTrue();
    expect(isTaskClosed("failed")).toBeFalse();
    expect(isTaskClosed("returned")).toBeFalse();
    expect(allowedTaskTransitions("failed")).toEqual(["pending", "abandoned"]);
  });
});

describe("batched revisions", () => {
  test("folds in order, so an operation may build on the one before it", () => {
    const plan = newPlan({
      title: "Fold",
      objective: "o",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });

    const { document, structural } = applyPlanRevisions(plan, [
      { type: "add_task", task: { title: "Two" } },
      { type: "reorder_task", task_id: "t2", after_task_id: null },
    ]);
    expect(document.tasks.map((task) => task.id)).toEqual(["t2", "t1"]);
    expect(structural).toBeTrue();
  });

  test("`structural` is true when any operation is, and false when none is", () => {
    const plan = newPlan({
      title: "Structural",
      objective: "o",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });

    expect(
      applyPlanRevisions(plan, [
        { type: "set_title", title: "A" },
        { type: "set_title", title: "B" },
      ]).structural,
    ).toBeFalse();
    expect(
      applyPlanRevisions(plan, [
        { type: "set_title", title: "A" },
        { type: "set_objective", objective: "changed" },
      ]).structural,
    ).toBeTrue();
  });

  test("the wire schema normalises either shape, and refuses both or neither", () => {
    const cas = { expected_revision: 1, expected_digest: "d", expected_spec_digest: "s" };
    const operation = { type: "set_title", title: "A" } as const;

    expect(
      revisePlanInputSchema.parse({ ...cas, operations: [operation, operation] }).operations,
    ).toHaveLength(2);
    expect(revisePlanInputSchema.parse({ ...cas, operation }).operations).toEqual([operation]);
    expect(() =>
      revisePlanInputSchema.parse({ ...cas, operation, operations: [operation] }),
    ).toThrow();
    expect(() => revisePlanInputSchema.parse(cas)).toThrow();
  });

  test("refuses oversized programmatic task and revision arrays", () => {
    expect(() =>
      newPlan({
        title: "Too many tasks",
        objective: "o",
        tasks: Array.from({ length: MAX_PLAN_TASKS + 1 }, () => ({ title: "task" })),
        createdByRun: "run-1",
      }),
    ).toThrow(`${MAX_PLAN_TASKS}`);

    const plan = newPlan({
      title: "Too many edits",
      objective: "o",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    expect(() =>
      applyPlanRevisions(
        plan,
        Array.from({ length: MAX_PLAN_BATCH_OPERATIONS + 1 }, () => ({
          type: "set_title" as const,
          title: "bounded",
        })),
      ),
    ).toThrow(`${MAX_PLAN_BATCH_OPERATIONS}`);
  });
});
