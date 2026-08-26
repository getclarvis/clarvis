import { describe, expect, test } from "bun:test";
import { PlanSession } from "../../src/capability/session.ts";
import {
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_LOCATOR_CHARS,
  MAX_PLAN_TASKS,
  createPlanStore,
  revisePlanInputSchema,
} from "../../src/index.ts";
import {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
  handlePlanRuntimeCall,
  planRuntimeTools,
} from "../../src/capability/runtime-tools.ts";
import { createEditablePlanRepository, type EditablePlanRepository } from "../helpers/store.ts";

async function fixture(): Promise<{
  repository: EditablePlanRepository;
  session: PlanSession;
}> {
  const repository = createEditablePlanRepository();
  return {
    repository,
    session: new PlanSession({
      store: createPlanStore({ repository }),
      executionId: "run-1",
      review: false,
    }),
  };
}

function expected(session: PlanSession): {
  expected_revision: number;
  expected_digest: string;
  expected_spec_digest: string;
} {
  const plan = session.cached()!;
  return {
    expected_revision: plan.revision,
    expected_digest: plan.digest,
    expected_spec_digest: plan.spec_digest,
  };
}

describe("plan runtime tools", () => {
  test("advertises only the new plan vocabulary", () => {
    expect(planRuntimeTools.map((tool) => tool.wireName)).toEqual([
      CREATE_PLAN_TOOL_NAME,
      READ_PLAN_TOOL_NAME,
      LIST_PLANS_TOOL_NAME,
      REVISE_PLAN_TOOL_NAME,
      TRANSITION_PLAN_TASK_TOOL_NAME,
    ]);
    const read = planRuntimeTools.find((tool) => tool.wireName === READ_PLAN_TOOL_NAME)!;
    expect(read.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string", maxLength: MAX_PLAN_LOCATOR_CHARS } },
    });
  });

  test("rejects oversized raw arrays before they reach the plan session", async () => {
    const { repository, session } = await fixture();
    const tooManyTasks = Array.from({ length: MAX_PLAN_TASKS + 1 }, () => ({ title: "task" }));
    const create = await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Too large", objective: "o", tasks: tooManyTasks, validation: [] },
      session,
    );
    expect(create.changed).toBeFalse();
    expect(create.error).toContain(`exceeds ${MAX_PLAN_TASKS}`);
    expect((await repository.list()).records).toHaveLength(0);

    await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Bounded", objective: "o", tasks: [{ title: "One" }], validation: [] },
      session,
    );
    const baseline = expected(session);
    const operations = Array.from({ length: MAX_PLAN_BATCH_OPERATIONS + 1 }, () => ({
      type: "set_title" as const,
      title: "still bounded",
    }));
    const revise = await handlePlanRuntimeCall(
      REVISE_PLAN_TOOL_NAME,
      { ...baseline, operations },
      session,
    );
    expect(revise.changed).toBeFalse();
    expect(revise.error).toContain(`exceeds ${MAX_PLAN_BATCH_OPERATIONS}`);

    const transitions = Array.from({ length: MAX_PLAN_BATCH_OPERATIONS + 1 }, () => ({
      task_id: "t1",
      status: "in_progress" as const,
    }));
    const transition = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      { ...baseline, transitions },
      session,
    );
    expect(transition.changed).toBeFalse();
    expect(transition.error).toContain(`exceeds ${MAX_PLAN_BATCH_OPERATIONS}`);
    expect(session.cached()?.revision).toBe(1);
  });

  test("creates, reads, lists, revises and transitions through PlanSession", async () => {
    const { session } = await fixture();
    expect(
      (
        await handlePlanRuntimeCall(
          CREATE_PLAN_TOOL_NAME,
          {
            title: "Runtime",
            objective: "Use the document",
            tasks: [{ title: "One" }],
            validation: ["tests pass"],
          },
          session,
        )
      ).changed,
    ).toBeTrue();

    const read = await handlePlanRuntimeCall(READ_PLAN_TOOL_NAME, {}, session);
    expect(read.result).toContain('"title":"Runtime"');
    const listed = await handlePlanRuntimeCall(LIST_PLANS_TOOL_NAME, {}, session);
    expect(listed.result).toContain(".clarvis/plans/");

    const reviseArgs = {
      ...expected(session),
      operation: { type: "set_objective" as const, objective: "Changed" },
    };
    expect(() => revisePlanInputSchema.parse(reviseArgs)).not.toThrow();
    const revised = await handlePlanRuntimeCall(REVISE_PLAN_TOOL_NAME, reviseArgs, session);
    expect(revised.changed).toBeTrue();
    expect(revised.document?.objective).toBe("Changed");

    const transitioned = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      {
        ...expected(session),
        task_id: "t1",
        status: "done",
        result: "Implemented and tested",
      },
      session,
    );
    expect(transitioned.changed).toBeTrue();
    expect(transitioned.document?.tasks[0]?.status).toBe("done");
  });

  test("every mutating result carries the NEXT compare-and-swap triple", async () => {
    const { session } = await fixture();
    const created = await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      {
        title: "Chain",
        objective: "Chain two writes with no read in between",
        tasks: [{ title: "One" }],
        validation: [],
      },
      session,
    );
    const cas = (payload: string): Record<string, unknown> =>
      JSON.parse(payload.slice(payload.indexOf("{"))) as Record<string, unknown>;

    const afterCreate = cas(created.result);
    expect(afterCreate).toMatchObject({
      revision: 1,
      spec_revision: 1,
      digest: created.document!.digest,
      spec_digest: created.document!.spec_digest,
      task_ids: ["t1"],
    });

    const revised = await handlePlanRuntimeCall(
      REVISE_PLAN_TOOL_NAME,
      {
        expected_revision: afterCreate.revision,
        expected_digest: afterCreate.digest,
        expected_spec_digest: afterCreate.spec_digest,
        operation: { type: "add_task", task: { title: "Two" } },
      },
      session,
    );
    expect(revised.changed).toBeTrue();

    const afterRevise = cas(revised.result);
    expect(afterRevise.revision).toBe(2);
    const transitioned = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      {
        expected_revision: afterRevise.revision,
        expected_digest: afterRevise.digest,
        expected_spec_digest: afterRevise.spec_digest,
        task_id: "t2",
        status: "abandoned",
        reason: "not needed",
      },
      session,
    );
    expect(transitioned.changed).toBeTrue();
    expect(cas(transitioned.result)).toMatchObject({
      revision: 3,
      digest: transitioned.document!.digest,
      spec_digest: transitioned.document!.spec_digest,
    });
  });

  test("transition_plan_task rejects a call with neither transitions nor a single task_id", async () => {
    const { session } = await fixture();
    await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Runtime", objective: "o", tasks: [{ title: "One" }], validation: [] },
      session,
    );

    const result = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      expected(session),
      session,
    );
    expect(result.changed).toBeFalse();
    expect(result.result).toContain("Pass `transitions`");
  });

  test("reconciles before mutation and reports stale CAS without overwriting", async () => {
    const { repository, session } = await fixture();
    const created = (
      await handlePlanRuntimeCall(
        CREATE_PLAN_TOOL_NAME,
        {
          title: "Runtime",
          objective: "Initial",
          tasks: [{ title: "One" }],
          validation: [],
        },
        session,
      )
    ).document!;
    const stale = expected(session);
    const source = (await repository.read(created.id))!.source;
    repository.poke(created.id, source.replace("Initial", "External"));

    const result = await handlePlanRuntimeCall(
      REVISE_PLAN_TOOL_NAME,
      {
        ...stale,
        operation: { type: "set_title", title: "Stale write" },
      },
      session,
    );
    expect(result.changed).toBeFalse();
    expect(result.result).toContain("changed since it was read");
    expect(repository.source(created.id)).not.toContain("Stale write");
  });

  test("reports a removed backing record as an error and invalidates stale CAS state", async () => {
    const { repository, session } = await fixture();
    const created = (
      await handlePlanRuntimeCall(
        CREATE_PLAN_TOOL_NAME,
        {
          title: "Runtime",
          objective: "Initial",
          tasks: [{ title: "One" }],
          validation: [],
        },
        session,
      )
    ).document!;
    expect(await repository.delete(created.id)).toBeTrue();

    const result = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      {
        expected_revision: created.revision,
        expected_digest: created.digest,
        expected_spec_digest: created.spec_digest,
        task_id: "t1",
        status: "in_progress",
      },
      session,
    );
    expect(result.changed).toBeFalse();
    expect(result.error).toContain("backing record is missing");
    expect(result.result).toContain("Do not retry this mutation");
    expect(result.removed).toMatchObject({ id: created.id, document: { title: "Runtime" } });
    expect(session.cached()).toBeUndefined();

    const retry = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      {
        expected_revision: created.revision,
        expected_digest: created.digest,
        expected_spec_digest: created.spec_digest,
        task_id: "t1",
        status: "in_progress",
      },
      session,
    );
    expect(retry.error).toContain("Do not retry this mutation");
    expect(retry.removed).toBeUndefined();
  });
});

describe("plan tools — batching", () => {
  test("one call moves every task, for one revision", async () => {
    const { session } = await fixture();
    await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      {
        title: "Batch",
        objective: "o",
        tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
        validation: ["tests pass"],
      },
      session,
    );

    const moved = await handlePlanRuntimeCall(
      TRANSITION_PLAN_TASK_TOOL_NAME,
      {
        ...expected(session),
        transitions: [
          { task_id: "t1", status: "done", result: "a" },
          { task_id: "t2", status: "done", result: "b" },
          { task_id: "t3", status: "abandoned", reason: "c" },
        ],
      },
      session,
    );
    expect(moved.changed).toBeTrue();
    expect(moved.document?.tasks.map((t) => t.status)).toEqual(["done", "done", "abandoned"]);
    expect(moved.document?.revision).toBe(2);
    // The result names every task it moved, not just the last.
    expect(moved.result).toContain('"tasks"');
  });

  test("one call applies every revision, for one revision and one spec_revision", async () => {
    const { session } = await fixture();
    await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Batch", objective: "o", tasks: [{ title: "One" }], validation: ["tests pass"] },
      session,
    );

    const revised = await handlePlanRuntimeCall(
      REVISE_PLAN_TOOL_NAME,
      {
        ...expected(session),
        operations: [
          { type: "set_objective", objective: "changed" },
          { type: "add_task", task: { title: "Two" } },
          { type: "add_task", task: { title: "Three" } },
        ],
      },
      session,
    );
    expect(revised.changed).toBeTrue();
    expect(revised.document?.tasks).toHaveLength(3);
    expect(revised.document?.revision).toBe(2);
    expect(revised.document?.spec_revision).toBe(2);
  });
});
