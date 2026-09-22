import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runGoalFileHostJourney } from "../helpers/goal-file-host-journey.ts";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("goal through the real file host and SDK HTTP", () => {
  it("lets the selected main run create and complete a calculator artifact", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    let step = 0;
    f.setResponder(async (request) => {
      step++;
      if (step === 1) {
        expect(request.tools?.map((tool) => tool.function.name)).toEqual(
          expect.arrayContaining(["create_goal", "get_goal", "update_goal"]),
        );
        return {
          name: "create_goal",
          arguments: {
            objective: "Build a browser calculator",
            criteria: [
              {
                id: "calculator",
                description: "calculator.html contains a working calculator surface",
                kind: "qualitative",
              },
            ],
            constraints: ["Keep the artifact self-contained"],
            exclusions: [],
            assumptions: [],
          },
        };
      }
      if (step === 2)
        return {
          name: "write_file",
          arguments: {
            path: "calculator.html",
            content:
              '<!doctype html><title>Calculator</title><button aria-label="7">7</button><output>7</output>',
          },
        };
      if (step === 3)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Calculator artifact is ready",
              assessments: [
                {
                  criterion_id: "calculator",
                  kind: "qualitative",
                  justification: "The self-contained HTML calculator was written to the workspace",
                  evidence_ids: [],
                },
              ],
            },
          },
        };
      return { text: "Calculator delivered." };
    });
    const session = (await f.client.sessions.get("conversation"))!;
    const started = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "Build a browser calculator",
      params: {
        execution_id: "calculator-main-run",
        agent: "solo",
        messages: [{ role: "user", content: "Build a browser calculator" }],
        goal_intent: { kind: "create", seed: "Build a browser calculator" },
      },
    });
    expect(await started.handle.done).toMatchObject({
      status: "completed",
      result: "Calculator delivered.",
    });
    await started.handle.closed;
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal).toMatchObject({
      status: "complete",
      objective: "Build a browser calculator",
      origin: { kind: "guided", seed: "Build a browser calculator" },
      runs: [{ execution_id: "calculator-main-run", automatic: false, phase: "closed" }],
    });
    expect(await Bun.file(join(f.workspaceRoot, "calculator.html")).text()).toContain("Calculator");
    expect(f.requests).toHaveLength(4);
    expect(new Set(f.requests.map((request) => request.prompt_cache_key)).size).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it("refuses workspace writes until create_goal is durably committed", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    const results: string[] = [];
    f.setResponder(async (request) => {
      if (f.requests.length === 1) {
        expect(request.tools?.map((tool) => tool.function.name)).toEqual(
          expect.arrayContaining(["create_goal", "write_file"]),
        );
        return { name: "write_file", arguments: { path: "premature.txt", content: "too soon" } };
      }
      const last = request.messages.findLast((message) => message.role === "tool");
      if (typeof last?.content === "string") results.push(last.content);
      if (f.requests.length === 2)
        return {
          name: "create_goal",
          arguments: { objective: "Keep premature writes out of the workspace" },
        };
      return { text: "Goal created without a premature write." };
    });
    const session = (await f.client.sessions.get("conversation"))!;
    const started = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "Keep premature writes out",
      params: {
        execution_id: "formulation-barrier",
        agent: "solo",
        messages: [{ role: "user", content: "Keep premature writes out" }],
        goal_intent: { kind: "create", seed: "Keep premature writes out" },
      },
    });
    await started.handle.done;
    await started.handle.closed;
    expect(results.some((text) => text.includes("create_goal"))).toBe(true);
    expect(await Bun.file(join(f.workspaceRoot, "premature.txt")).exists()).toBe(false);
  });

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
    const session = await f.client.sessions.get("conversation");
    expect(session?.turns[0]?.user_preview).toBe(
      "Work toward the persistent goal: Inspect plan queries",
    );
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
    f.setResponder(async () => ({ text: "Independent answer after Goal budget exhaustion" }));
    const session = (await f.client.sessions.get("conversation"))!;
    const independent = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "Answer independently",
      params: {
        execution_id: "after-budget-limited",
        agent: "solo",
        intent: "operator",
        messages: [{ role: "user", content: "Answer independently" }],
      },
    });
    expect(await independent.handle.done).toMatchObject({ status: "completed" });
    await independent.handle.closed;
    const after = (await f.client.goals.get("conversation")).state.current!;
    expect(after).toEqual(goal);
    expect((await f.client.sessions.get("conversation"))!.turns.at(-1)).toMatchObject({
      execution_id: "after-budget-limited",
      status: "done",
    });
    expect(f.requests).toHaveLength(2);
  });

  it("continues a stalled stage in a successor and stops at the stage progress limit", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => ({ name: "get_goal", arguments: {} }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Keep stalling until the goal stops admitting stages",
        limits: { max_net_tokens: 100_000 },
      },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status !== "active",
    );
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    /**
     * A stage that stopped without advancing is the Kernel's own responsibility: the Goal
     * stays active and a successor is admitted from the durable decision, without any
     * checkpoint. The bound is the Goal's own stage allowance, and it blocks the Goal
     * through the ordinary admission path rather than looping.
     */
    expect(goal).toMatchObject({
      status: "blocked",
      reason: "Goal stage progress limit reached",
      auto_continuations: 2,
      no_progress_stages: 3,
    });
    expect(goal.runs.map((run) => run.outcome)).toEqual(["failed", "failed", "failed"]);
    expect(goal.runs.map((run) => run.cause)).toEqual(["stagnation", "stagnation", "stagnation"]);
    expect(goal.runs.map((run) => run.decision)).toEqual(["continue", "continue", "closed"]);
    expect(goal.runs.every((run) => run.checkpoint === undefined)).toBe(true);
    /** The successor is told how the previous stage ended, in the host's own words. */
    const successor = f.requests[6]!;
    expect(successor.messages.at(-1)).toMatchObject({
      content: expect.stringContaining("The previous stage stopped without progress"),
    });
  });

  it("counts host-observed activity at settlement without a model-declared fingerprint", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => {
      switch (f.requests.length) {
        case 1:
          return { name: "write_file", arguments: { path: "result.txt", content: "done\n" } };
        case 2:
          return {
            name: "update_goal",
            arguments: {
              update: { action: "checkpoint", summary: "Wrote the result", next_step: "Verify it" },
            },
          };
        default:
          return {
            name: "update_goal",
            arguments: { update: { action: "blocked", reason: "Review the written result" } },
          };
      }
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Write and verify the result",
        criteria: [
          {
            id: "written",
            description: "The result file was written",
            kind: "host",
            verification: { kind: "tool_success", tool_name: "write_file" },
          },
        ],
        limits: { max_net_tokens: 100_000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    /**
     * The host decides relevance from the activity it observed, not from the identifiers the
     * model chose to cite: this stage checkpointed without naming any evidence, and its
     * workspace change still counts as progress, so the sequence resets instead of spending
     * a stage of the allowance.
     */
    expect(goal.runs[0]).toMatchObject({
      disposition: "checkpoint",
      decision: "continue",
      progress_observed: true,
    });
    expect(goal.runs[0]!.activity?.length).toBeGreaterThan(0);
    expect(goal.no_progress_stages).toBe(0);
    expect(goal).toMatchObject({ status: "blocked", auto_continuations: 1 });
  });

  it("records a transient ending with its durable instant and blocks on unmeasured consumption", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => {
      /** The provider fails once, transiently and without a Retry-After. */
      if (f.requests.length === 1) return { status: 503, message: "Synthetic provider outage" };
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "The provider recovered" } },
      };
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Survive a transient provider failure",
        limits: { max_net_tokens: 100_000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    /**
     * A call that failed reports no usage, so the recovered charge is unknown and unmeasured
     * consumption blocks the Goal before any recovery rule is asked — the pending instant a
     * bounded backoff records is still stored, and admission is what must not keep refusing an
     * instant that has already passed.
     */
    expect(goal.runs[0]).toMatchObject({
      outcome: "failed",
      cause: "transient",
      decision: "attention",
      progress_observed: false,
    });
    expect(goal.runs[0]!.not_before).toBeDefined();
    expect(goal).toMatchObject({ status: "blocked", auto_continuations: 0 });
    expect(goal.reason).toContain("Consumption is unknown");
    expect(goal.reason).toContain("resume the goal to accept the gap");
    expect(goal.runs).toHaveLength(1);
  });

  it("starts a successor when the guided creation stage itself checkpointed", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => {
      switch (f.requests.length) {
        case 1:
          return {
            name: "create_goal",
            arguments: { objective: "Keep the guided request running across stages" },
          };
        case 2:
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "checkpoint",
                summary: "The first stage ended",
                next_step: "Finish the verification",
              },
            },
          };
        case 3:
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Requested result verified",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Observed the requested result",
                  },
                ],
              },
            },
          };
        default:
          return { text: "Done" };
      }
    });
    const session = (await f.client.sessions.get("conversation"))!;
    const guided = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "Keep the guided request running",
      params: {
        execution_id: "guided-creation",
        agent: "solo",
        messages: [{ role: "user", content: "Keep the guided request running" }],
        goal_intent: { kind: "create", seed: "Keep the guided request running" },
      },
    });
    expect((await guided.handle.done).disposition).toBe("checkpoint");
    await f.until(() => f.host.stats().runs === 0);
    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal).toMatchObject({ status: "complete", auto_continuations: 1 });
    expect(goal.runs).toHaveLength(2);
    expect(goal.runs[0]).toMatchObject({ disposition: "checkpoint", decision: "continue" });
    expect(goal.runs[1]).toMatchObject({
      automatic: true,
      outcome: "completed",
      decision: "complete",
    });
    const stored = (await f.client.sessions.get("conversation"))!.turns.map(
      (turn) => turn.user_preview,
    );
    expect(stored[1]).toContain("previous stage: checkpoint");
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
      input: 3060 + f.stewardUsages.reduce((sum, usage) => sum + usage.input, 0),
      output: 30 + f.stewardUsages.reduce((sum, usage) => sum + usage.output, 0),
    });
    expect(f.requests).toHaveLength(3);
  });

  it("admits the operator's own turn while the Goal is paused and starts no Goal stage", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    f.setResponder(async () => ({ text: "Nothing to continue yet." }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Keep working while the operator types",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    const settled = await f.client.goals.get("conversation");
    const stages = settled.state.current!.runs.length;
    const goalId = settled.state.current!.goal_id;
    const requestsBefore = f.requests.length;

    // The operator's turn is admitted as its own intent: the Goal's state cannot veto it, and it
    // does not become a Goal stage.
    const session = (await f.client.sessions.get("conversation"))!;
    const started = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "do something else entirely",
      params: {
        execution_id: "operator-turn",
        agent: "solo",
        messages: [{ role: "user", content: "do something else entirely" }],
        intent: "operator",
      },
    });
    expect(await started.handle.done).toMatchObject({ status: "completed" });
    await f.until(() => f.requests.length > requestsBefore);

    const after = await f.client.goals.get("conversation");
    expect(after.state.current).toMatchObject({
      goal_id: goalId,
      objective: settled.state.current!.objective,
    });
    // No stage was admitted for the operator's turn, and the Goal's own pending work is stopped.
    expect(after.state.current!.status).not.toBe("active");
    expect(after.state.current!.runs).toHaveLength(stages);

    // An automatic turn over the same Goal is still refused, and the refusal is typed: the client
    // learns that the Goal needs a decision instead of having to read the reason.
    await expect(
      f.client.hosting!.start({
        session_id: "conversation",
        session_revision: (await f.client.sessions.get("conversation"))!.revision!,
        kind: "conversation",
        user_preview: "continue the stage",
        params: {
          execution_id: "automatic-turn",
          agent: "solo",
          messages: [{ role: "user", content: "continue the stage" }],
          intent: "automatic",
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { goal_outcome: "needs_input" },
    });
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
    // An explicit resume is what accepts the gap: the stage's consumption was never reported, so
    // there is nothing left to reconcile and the operator is not asked to repair a record the host
    // could not have written either.
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "resume",
      action: { kind: "resume" },
    });
    const after = await f.client.goals.get("conversation");
    expect(after.state.current).toMatchObject({
      status: "active",
      consumption: { usage_unknown: true },
    });
    expect(after.state.current!.consumption.usage_accepted_runs).toEqual([
      after.state.current!.runs[0]!.execution_id,
    ]);
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
        user_preview: "Automation cannot resume a paused goal",
        params: {
          execution_id: "ordinary",
          intent: "automatic",
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
