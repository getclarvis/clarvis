import { expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import {
  currentPlanTask,
  isAvailablePlan,
  isExpectedPlanDiscard,
  isLivePlan,
  reducePlanProjection,
} from "../../src/adapters/plan-projection.ts";

const created: Extract<RunEvent, { type: "plan_created" }> = {
  type: "plan_created",
  at: 1,
  id: "11111111-1111-1111-1111-111111111111",
  path: ".clarvis/plans/work.md",
  title: "Work",
  status: "active",
  retention: "keep",
  revision: 2,
  spec_revision: 1,
  tasks: [{ id: "t1", title: "Implement", status: "in_progress" }],
};

test("projects the complete public plan metadata and a flat task list", () => {
  expect(reducePlanProjection(null, created)).toMatchObject({
    id: created.id,
    path: created.path,
    title: "Work",
    status: "active",
    retention: "keep",
    revision: 2,
    spec_revision: 1,
    tasks: [{ id: "t1", title: "Implement", status: "in_progress" }],
  });
});

test("only active and approval-pending projections count as live plans", () => {
  const active = reducePlanProjection(null, created)!;
  expect(isLivePlan(active)).toBe(true);
  expect(isLivePlan({ ...active, status: "awaiting_approval" })).toBe(true);
  expect(isLivePlan({ ...active, status: "completed" })).toBe(false);
  expect(isLivePlan({ ...active, removed: true })).toBe(false);
  expect(isLivePlan(null)).toBe(false);
});

test("retained terminal plans remain available for full-detail navigation", () => {
  const active = reducePlanProjection(null, created)!;
  expect(isAvailablePlan(active)).toBe(true);
  expect(isAvailablePlan({ ...active, status: "completed" })).toBe(true);
  expect(isAvailablePlan({ ...active, status: "failed" })).toBe(true);
  expect(isAvailablePlan({ ...active, status: "cancelled" })).toBe(true);
  expect(isAvailablePlan({ ...active, removed: true })).toBe(false);
  expect(isAvailablePlan(null)).toBe(false);
});

test("a returned task's result and a failed task's error survive the projection", () => {
  const projected = reducePlanProjection(null, {
    ...created,
    type: "plan_updated",
    at: 2,
    change: "task",
    revision: 3,
    tasks: [
      {
        id: "t1",
        title: "Implement",
        status: "returned",
        assignee: "coder",
        result: "wired the adapter; tests pending",
      },
      { id: "t2", title: "Verify", status: "failed", error: "bun test exited 1" },
      { id: "t3", title: "Document", status: "abandoned", reason: "superseded by t1" },
    ],
  });

  expect(projected?.tasks).toEqual([
    {
      id: "t1",
      title: "Implement",
      status: "returned",
      assignee: "coder",
      result: "wired the adapter; tests pending",
    },
    { id: "t2", title: "Verify", status: "failed", error: "bun test exited 1" },
    { id: "t3", title: "Document", status: "abandoned", reason: "superseded by t1" },
  ]);
});

test("currentPlanTask surfaces a returned task ahead of the next pending one", () => {
  const plan = reducePlanProjection(null, {
    ...created,
    tasks: [
      { id: "t1", title: "Explore", status: "returned", result: "found the seam" },
      { id: "t2", title: "Implement", status: "pending" },
    ],
  })!;
  expect(currentPlanTask(plan)).toMatchObject({ id: "t1", result: "found the seam" });

  const running = reducePlanProjection(null, {
    ...created,
    tasks: [
      { id: "t1", title: "Explore", status: "returned", result: "found the seam" },
      { id: "t2", title: "Implement", status: "in_progress" },
    ],
  })!;
  expect(currentPlanTask(running)).toMatchObject({ id: "t2", status: "in_progress" });
});

test("a review outcome persists through later task updates of the same plan", () => {
  const reviewed = reducePlanProjection(reducePlanProjection(null, created), {
    ...created,
    type: "plan_review_resolved",
    at: 2,
    outcome: "approved",
  });
  expect(reviewed?.reviewOutcome).toBe("approved");

  const advanced = reducePlanProjection(reviewed, {
    ...created,
    type: "plan_updated",
    at: 3,
    change: "task",
    revision: 3,
    tasks: [{ id: "t1", title: "Implement", status: "done", result: "shipped" }],
  });
  expect(advanced?.reviewOutcome).toBe("approved");

  const other = reducePlanProjection(advanced, {
    ...created,
    type: "plan_created",
    at: 4,
    id: "22222222-2222-2222-2222-222222222222",
    path: ".clarvis/plans/other.md",
  });
  expect(other?.reviewOutcome).toBeUndefined();
});

test("review resolution and removal preserve the last confirmed projection", () => {
  const projected = reducePlanProjection(null, created);
  const reviewed = reducePlanProjection(projected, {
    ...created,
    type: "plan_review_resolved",
    at: 2,
    outcome: "approved",
  });
  const removed = reducePlanProjection(reviewed, {
    type: "plan_removed",
    at: 3,
    id: created.id,
    path: created.path,
    revision: 3,
    spec_revision: 1,
  });

  expect(reviewed?.reviewOutcome).toBe("approved");
  expect(removed).toMatchObject({
    title: "Work",
    revision: 3,
    spec_revision: 1,
    removed: true,
  });
});

test("a completed discard plan recognizes its retention removal as expected", () => {
  const disposable = reducePlanProjection(null, { ...created, retention: "discard" });
  const completed = reducePlanProjection(disposable, {
    ...created,
    type: "plan_updated",
    change: "status",
    at: 2,
    status: "completed",
    retention: "discard",
    revision: 3,
    tasks: [{ id: "t1", title: "Implement", status: "done", result: "shipped" }],
  });
  const removed = reducePlanProjection(completed, {
    type: "plan_removed",
    at: 3,
    id: created.id,
    path: created.path,
    revision: 3,
    spec_revision: 1,
  });

  expect(removed).toMatchObject({
    status: "completed",
    retention: "discard",
    removed: true,
  });
  expect(isExpectedPlanDiscard(removed!)).toBe(true);
  expect(isExpectedPlanDiscard({ ...removed!, retention: "keep" })).toBe(false);
  expect(isExpectedPlanDiscard({ ...removed!, status: "failed" })).toBe(false);
});

test("an orphan removal still projects an explicit unavailable plan", () => {
  const removed = reducePlanProjection(null, {
    type: "plan_removed",
    at: 1,
    id: "missing-plan",
    path: ".clarvis/plans/missing-plan.md",
    revision: 4,
    spec_revision: 2,
  });

  expect(removed).toEqual({
    id: "missing-plan",
    path: ".clarvis/plans/missing-plan.md",
    title: "Plan unavailable",
    status: "failed",
    retention: "keep",
    revision: 4,
    spec_revision: 2,
    tasks: [],
    removed: true,
  });
});

test("an out-of-order projection cannot roll the current task backwards", () => {
  const current = reducePlanProjection(null, {
    type: "plan_updated",
    change: "task",
    at: 20,
    id: "plan-1",
    title: "Stable plan",
    status: "active",
    retention: "keep",
    revision: 5,
    spec_revision: 1,
    tasks: [
      { id: "t1", title: "First", status: "done" },
      { id: "t2", title: "Second", status: "in_progress" },
    ],
  });
  const stale = reducePlanProjection(current, {
    type: "plan_updated",
    change: "task",
    at: 10,
    id: "plan-1",
    title: "Stable plan",
    status: "active",
    retention: "keep",
    revision: 4,
    spec_revision: 1,
    tasks: [
      { id: "t1", title: "First", status: "in_progress" },
      { id: "t2", title: "Second", status: "pending" },
    ],
  });
  expect(stale).toBe(current);
  expect(stale?.tasks[1]?.status).toBe("in_progress");
});
