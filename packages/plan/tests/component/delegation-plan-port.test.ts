import { describe, expect, test } from "bun:test";
import { createDelegationPlanPort } from "../../src/capability/delegation-port.ts";
import { PlanSession } from "../../src/capability/session.ts";
import { createPlanStore } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";

async function fixture() {
  const session = new PlanSession({
    store: createPlanStore({ repository: createInMemoryPlanRepository() }),
    executionId: "run-1",
    review: false,
  });
  await session.create({
    title: "Plan",
    objective: "Delegate safely",
    tasks: [{ title: "One", exit: "Tests pass" }],
  });
  return { session, port: createDelegationPlanPort(session) };
}

describe("delegation plan port", () => {
  test("claims a task and persists delegation failure", async () => {
    const { session, port } = await fixture();
    await port.reconcile?.();
    expect(port.openTasks().map((task) => task.id)).toEqual(["t1"]);
    expect(await port.markSpawned("t1")).toBeTrue();
    expect((await session.task("t1"))?.status).toBe("in_progress");
    expect(await port.markFailed("t1", "Sub-agent failed")).toBeTrue();
    expect((await session.task("t1"))?.status).toBe("failed");
  });

  test("getTask reads the current document's task by id, and undefined for an unknown one", async () => {
    const { port } = await fixture();
    await port.reconcile?.();
    expect(port.getTask("t1")?.title).toBe("One");
    expect(port.getTask("no-such-task")).toBeUndefined();
  });

  test("retries failed tasks through pending and does not judge success", async () => {
    const { session, port } = await fixture();
    await port.markSpawned("t1");
    await port.markFailed("t1", "First attempt failed");
    const before = session.cached()!.revision;
    expect(await port.markSpawned("t1")).toBeTrue();
    expect((await session.task("t1"))?.status).toBe("in_progress");
    expect(session.cached()!.revision).toBe(before + 2);
  });

  test("records a hand-back as returned, and never as done", async () => {
    const { session, port } = await fixture();
    await port.markSpawned("t1");
    expect(await port.markReturned?.("t1", "here is what I did")).toBeTrue();
    const task = await session.task("t1");
    // `returned` is not a closed state: the lead must still judge it, and only
    // `transition_plan_task` may close it. Delegation recording success as
    // `done` would take that judgment away from the parent.
    expect(task?.status).toBe("returned");
    expect(task?.result).toContain("here is what I did");
  });

  test("a hand-back is only recorded for a task the child actually holds", async () => {
    const { port } = await fixture();
    expect(await port.markReturned?.("t1", "never spawned")).toBeFalse();
  });
});
