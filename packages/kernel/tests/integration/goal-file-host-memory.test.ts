import { afterEach, expect, it } from "bun:test";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it.each(["off", "on", "review"] as const)(
  "carries the %s source catalog into indexing and refuses inherited plan and delegation calls",
  async (plansMode) => {
    const f = await createGoalFileHostFixture({ memory: true, plansMode });
    cleanups.push(f.close);
    f.setResponder(async () => {
      if (f.requests.length === 1)
        return {
          name: "update_goal",
          arguments: { update: { action: "blocked", reason: "Await operator input" } },
        };
      if (f.requests.length === 2)
        return {
          name: "create_plan",
          arguments: {
            title: "Must not execute",
            objective: "Forbidden",
            tasks: [{ title: "Forbidden" }],
            validation: [],
          },
        };
      if (f.requests.length === 3)
        return {
          name: "delegate_task",
          arguments: { title: "Forbidden", task: "Forbidden", task_id: "t1", profile: "helper" },
        };
      return { text: "Nothing to record in memory." };
    });
    const created = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Await operator input",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    await f.until(async () => {
      const job = (await f.client.memory.jobs()).jobs.find(
        (job) => job.run_id === created.execution_id,
      );
      return job !== undefined && job.attempts > 0 && !["pending", "running"].includes(job.state);
    });
    expect((await f.client.memory.jobs()).jobs[0]).toMatchObject({
      state: "completed",
      attempts: 1,
    });
    expect(f.requests).toHaveLength(4);
    expect(f.errors).toEqual([]);
    expect((await f.planStore.list()).plans).toEqual([]);
    const source = f.requests[0]!;
    const calls = f.requests.slice(1);
    const expected = source.tools!.filter(
      (tool) => !["get_goal", "update_goal"].includes(tool.function.name),
    );
    expect(expected.some((tool) => tool.function.name === "delegate_task")).toBe(
      plansMode !== "off",
    );
    for (const call of calls) {
      expect(call.tools).toEqual(expected);
      expect(call.prompt_cache_key).not.toBe(source.prompt_cache_key);
      expect(call.prompt_cache_key).toBe(calls[0]!.prompt_cache_key);
    }
    for (let i = 1; i < f.requests.length; i++) {
      const previous = f.requests[i - 1]!;
      expect(f.requests[i]!.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    }
    expect(JSON.stringify(calls[1]!.messages)).toContain("not available");
    expect(JSON.stringify(calls[2]!.messages)).toContain("not available");
  },
);

it("indexes a paused goal checkpoint without mutating its open discard plan or inheriting its finalization gates", async () => {
  const f = await createGoalFileHostFixture({ memory: true, planRetention: "discard" });
  cleanups.push(f.close);
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cleanups.push(async () => release.resolve());
  f.setResponder(async () => {
    if (f.requests.length === 1)
      return {
        name: "create_plan",
        arguments: {
          title: "Preserve paused work",
          objective: "Complete after operator resume",
          tasks: [{ title: "Verify result" }],
          validation: [],
        },
      };
    if (f.requests.length === 2) {
      arrived.resolve();
      await release.promise;
      return {
        name: "update_goal",
        arguments: {
          update: { action: "checkpoint", summary: "Plan ready", next_step: "Verify result" },
        },
      };
    }
    return { text: "Nothing to record in memory." };
  });
  const created = await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "create",
    action: {
      kind: "create",
      objective: "Preserve paused plan during memory indexing",
      limits: { max_net_tokens: 10000 },
    },
  });
  await arrived.promise;
  const initial = (await f.planStore.list()).plans[0]!;
  expect(initial.tasks[0]?.status).toBe("pending");
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: (await f.client.goals.get("conversation")).state.revision,
    operation_id: "pause",
    action: { kind: "pause" },
  });
  release.resolve();
  await f.until(() => f.host.stats().runs === 0);
  await f.until(async () => {
    const job = (await f.client.memory.jobs()).jobs.find(
      (job) => job.run_id === created.execution_id,
    );
    return job !== undefined && job.attempts > 0 && !["pending", "running"].includes(job.state);
  });
  expect(await f.planStore.read(initial.id)).toEqual(initial);
  const job = (await f.client.memory.jobs()).jobs.find(
    (job) => job.run_id === created.execution_id,
  )!;
  expect(job).toMatchObject({ state: "completed", attempts: 1 });
  expect(f.requests).toHaveLength(3);
  expect(f.errors).toEqual([]);
  const goal = (await f.client.goals.get("conversation")).state.current!;
  expect(goal).toMatchObject({ status: "paused", auto_continuations: 0 });
  expect(goal.runs).toHaveLength(1);
  expect(goal.runs[0]).toMatchObject({ phase: "closed", disposition: "checkpoint" });
  const lead = f.requests[1]!;
  const memory = f.requests[2]!;
  expect(memory.prompt_cache_key).not.toBe(lead.prompt_cache_key);
  expect(memory.messages.slice(0, lead.messages.length)).toEqual(lead.messages);
  expect(memory.tools).toEqual(
    lead.tools?.filter((tool) => !["get_goal", "update_goal"].includes(tool.function.name)),
  );
  expect(memory.tools?.some((tool) => tool.function.name === "delegate_task")).toBe(true);
});
