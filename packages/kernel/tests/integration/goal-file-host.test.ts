import { afterEach, describe, expect, it } from "bun:test";
import { runGoalFileHostJourney } from "../helpers/goal-file-host-journey.ts";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("goal through the real file host and SDK HTTP", () => {
  it("reads and lists the active plan with explicit absent options through the actual SDK", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => {
      switch (f.requests.length) {
        case 1:
          return {
            name: "create_plan",
            arguments: {
              title: "Query defaults",
              objective: "Inspect the active plan",
              tasks: [{ title: "Inspect" }],
              validation: [],
            },
          };
        case 2:
          return { name: "read_plan", arguments: { id: null } };
        case 3:
          return {
            name: "list_plans",
            arguments: { cursor: null, limit: null, status: null, retention: null },
          };
        default:
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "blocked",
                reason: "Inspection finished; retain the plan for user review",
              },
            },
          };
      }
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Inspect plan queries",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    const detail = await f.host.kernel.runs.get(goal.runs[0]!.execution_id);
    const queries = detail.events.filter(
      (event) =>
        event.type === "tool_call" &&
        ["read_plan", "list_plans"].includes(event.tool || event.server),
    );
    expect(queries).toHaveLength(2);
    for (const query of queries)
      expect(query).toMatchObject({ ok: true, result: expect.stringContaining("Query defaults") });
    expect(f.requests).toHaveLength(4);
    expect(goal.auto_continuations).toBe(0);
  });

  it("reports budget_limited after the real loop stops with exhausted measured usage", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => ({ name: "get_goal", arguments: {} }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Stop at the finite goal budget",
        limits: { max_net_tokens: 100 },
      },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status !== "active",
    );
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal).toMatchObject({
      status: "budget_limited",
      reason: "Goal token budget exhausted",
      auto_continuations: 0,
      consumption: { input: 1010, output: 10, cached: 500, net_tokens: 520, overrun_tokens: 420 },
      runs: [{ phase: "closed", outcome: "failed" }],
    });
    expect(f.requests).toHaveLength(1);
    expect((await f.host.kernel.runs.get(goal.runs[0]!.execution_id)).result).toMatchObject({
      status: "failed",
      ended_reason: "budget_exhausted",
    });
  });

  it("continues with conservative input accounting when only the provider cache detail is missing", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => {
      if (f.requests.length === 1)
        return {
          name: "update_goal",
          arguments: {
            update: { action: "checkpoint", summary: "First stage", next_step: "Finish" },
          },
          usage: "no_cache",
        };
      if (f.requests.length === 2)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Done",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "Synthetic stage complete",
                },
              ],
            },
          },
          usage: "no_cache",
        };
      return { text: "Done", usage: "no_cache" };
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Use conservative cache accounting",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal).toMatchObject({
      status: "complete",
      auto_continuations: 1,
      consumption: {
        input: 3060,
        output: 30,
        net_tokens: 3090,
        usage_unknown: false,
        cache_estimated: true,
      },
    });
    expect(goal.consumption.cached).toBeUndefined();
    expect((await f.client.sessions.get("conversation"))!.totals).toEqual({
      input: 3060,
      output: 30,
    });
    expect(f.requests).toHaveLength(3);
  });

  it("blocks an otherwise valid checkpoint when the actual SDK response omitted usage", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => ({
      name: "update_goal",
      arguments: {
        update: { action: "checkpoint", summary: "Ready", next_step: "Must wait for accounting" },
      },
      usage: "missing",
    }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Account for the actual provider response",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    const view = await f.client.goals.get("conversation");
    expect(view.state.current).toMatchObject({
      status: "blocked",
      auto_continuations: 0,
      consumption: { usage_unknown: true },
    });
    expect(view.state.current!.runs[0]).toMatchObject({
      phase: "closed",
      disposition: "checkpoint",
      usage: { kind: "unknown" },
    });
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
    await expect(
      f.client.goals.control({
        session_id: "conversation",
        expected_revision: view.state.revision,
        operation_id: "resume",
        action: { kind: "resume" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.requests).toHaveLength(1);
  });

  it("pauses future work during inference and resumes only through explicit IPC control", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => release.resolve());
    f.setResponder(async () => {
      switch (f.requests.length) {
        case 1:
          arrived.resolve();
          await release.promise;
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "checkpoint",
                summary: "Stage finished",
                next_step: "Finish after resume",
              },
            },
          };
        case 2:
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Resumed task complete",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Completed the resumed synthetic stage",
                  },
                ],
              },
            },
          };
        case 3:
          return { text: "Resumed goal finished." };
        default:
          throw new Error("Unexpected automatic work after pause");
      }
    });
    const created = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Exercise pause and resume",
        limits: { max_net_tokens: 10000 },
      },
    });
    await arrived.promise;
    const pause = {
      session_id: "conversation",
      expected_revision: (await f.client.goals.get("conversation")).state.revision,
      operation_id: "pause",
      action: { kind: "pause" as const },
    };
    const paused = await f.client.goals.control(pause);
    expect(await f.client.goals.control(pause)).toEqual(paused);
    const busy = await f.client.goals.get("conversation");
    expect(busy.state.current!.status).toBe("paused");
    expect(busy.physical_run!.execution_id).toBe(created.execution_id!);
    expect(f.requests).toHaveLength(1);
    release.resolve();
    await f.until(() => f.host.stats().runs === 0);
    const beforeResume = await f.client.goals.get("conversation");
    expect(beforeResume.state.current).toMatchObject({ status: "paused", auto_continuations: 0 });
    expect(beforeResume.state.current!.runs).toHaveLength(1);
    expect(beforeResume.state.current!.runs[0]).toMatchObject({
      phase: "closed",
      disposition: "checkpoint",
    });
    const session = (await f.client.sessions.get("conversation"))!;
    await expect(
      f.client.hosting!.start({
        session_id: "conversation",
        session_revision: session.revision!,
        kind: "conversation",
        user_preview: "Ordinary input cannot resume a paused goal",
        params: {
          execution_id: "ordinary",
          agent: "solo",
          messages: [{ role: "user", content: "Continue" }],
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.requests).toHaveLength(1);
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: beforeResume.state.revision,
      operation_id: "resume",
      action: { kind: "resume" },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);
    const finished = (await f.client.goals.get("conversation")).state.current!;
    expect(finished.runs.map((run) => run.automatic)).toEqual([false, false]);
    expect(finished.consumption.usage_unknown).toBe(false);
    expect(f.requests).toHaveLength(3);
    expect(new Set(f.requests.map((request) => request.prompt_cache_key)).size).toBe(1);
    expect(f.requests[1]!.messages.slice(0, f.requests[0]!.messages.length)).toEqual(
      f.requests[0]!.messages,
    );
    expect(f.requests[1]!.tools).toEqual(f.requests[0]!.tools);
  });

  it.each(["pause", "cancel"] as const)(
    "%s cancels an actual pending SDK request without admitting a successor",
    async (kind) => {
      const f = await createGoalFileHostFixture();
      cleanups.push(f.close);
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      cleanups.push(async () => release.resolve());
      f.setResponder(async () => {
        arrived.resolve();
        await release.promise;
        return {
          name: "update_goal",
          arguments: {
            update: { action: "checkpoint", summary: "Too late", next_step: "Must not run" },
          },
        };
      });
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Cancel during physical inference",
          limits: { max_net_tokens: 10000 },
        },
      });
      await arrived.promise;
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: (await f.client.goals.get("conversation")).state.revision,
        operation_id: "stop",
        action: kind === "pause" ? { kind, running: true } : { kind },
      });
      await f.until(() => f.host.stats().runs === 0);
      release.resolve();
      await f.until(() => f.usages.length === 1);
      const view = await f.client.goals.get("conversation");
      expect(view.physical_run).toBeUndefined();
      expect(view.state.current).toMatchObject({
        status: kind === "pause" ? "paused" : "cancelled",
        auto_continuations: 0,
      });
      expect(view.state.current!.runs).toHaveLength(1);
      expect(view.state.current!.runs[0]).toMatchObject({ phase: "closed", outcome: "cancelled" });
      expect(view.state.current!.runs[0]!.checkpoint).toBeUndefined();
      expect(view.state.current!.consumption.usage_unknown).toBe(true);
      expect(f.requests).toHaveLength(1);
      expect(f.errors).toEqual([]);
    },
  );

  it("automatically continues two checkpoints with a delegated plan and reconciles every physical call", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    await runGoalFileHostJourney(f);
  });
});
