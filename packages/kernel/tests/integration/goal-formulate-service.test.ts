import { afterEach, describe, expect, it } from "bun:test";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOnlyTools } from "@clarvis/tools";
import type { GoalChange } from "@clarvis/protocol";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("Goal formulation through the real file host", () => {
  it("returns a rejected definition to the selected main agent before activation", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const activities: string[] = [];
    const unsubscribe = await fixture.client.goals.subscribe("conversation", (change) => {
      if (change.formulation_activity !== undefined)
        activities.push(change.formulation_activity.phase);
    });
    cleanups.push(async () => unsubscribe());
    let reviews = 0;
    fixture.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result")) {
        const frame = String(request.messages.at(-1)!.content);
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: frame.includes("Preserve the requested exclusion")
              ? "Implement the request without publishing"
              : "Implement the request",
            criteria: [],
            constraints: [],
            exclusions: frame.includes("Preserve the requested exclusion")
              ? ["Do not publish"]
              : [],
            assumptions: [],
            normative_source_paths: [],
          },
        };
      }
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Fixture work run is observable" } },
      };
    });
    fixture.setStewardResponder(async (request) => {
      const frame = JSON.parse(String(request.messages.at(-1)!.content)) as { mode?: string };
      if (frame.mode === "definition") {
        reviews++;
        return {
          name: "submit_result",
          arguments:
            reviews === 1
              ? {
                  decision: "definition",
                  verdict: "revise_definition",
                  summary: "A material exclusion was lost",
                  guidance: "Preserve the requested exclusion",
                }
              : {
                  decision: "definition",
                  verdict: "accept_definition",
                  summary: "The definition is faithful",
                },
        };
      }
      throw new Error("Unexpected work review in formulation fixture");
    });
    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "definition-revision",
      mode: "guided",
      seed: "Implement the request without publishing",
    });
    expect(receipt.formulation.outcome).toBe("created");
    expect(reviews).toBe(2);
    expect(activities[0]).toBe("thinking");
    expect(activities.at(-1)).toBe("idle");
    expect(fixture.requests[1]!.messages.at(-1)!.content).toContain(
      "Preserve the requested exclusion",
    );
    expect((await fixture.client.goals.get("conversation")).state.current).toMatchObject({
      objective: "Implement the request without publishing",
      exclusions: ["Do not publish"],
    });
  });

  it("creates one inspectable guided Goal from a separate read-only run and starts normal work", async () => {
    const fixture = await createGoalFileHostFixture({ budgetTokenLimit: 123_456 });
    cleanups.push(fixture.close);
    await writeFile(
      join(fixture.workspaceRoot, "request.md"),
      "Implement the semantic Goal agent.\n",
    );
    fixture.setResponder(async (request) => {
      const tools = request.tools?.map((tool) => tool.function.name) ?? [];
      if (tools.includes("submit_result")) {
        if (
          fixture.requests.filter((item) =>
            item.tools?.some((tool) => tool.function.name === "submit_result"),
          ).length === 1
        )
          return {
            name: "read_file",
            arguments: { path: "request.md", offset: 1, limit: 2000 },
          };
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Implement the semantic Goal agent",
            criteria: [
              {
                description: "The guided request creates and starts one Goal",
                kind: "qualitative",
              },
            ],
            constraints: ["Use the existing durable Goal runtime"],
            exclusions: ["Do not publish"],
            assumptions: ["request.md is the normative request"],
            normative_source_paths: ["request.md"],
          },
        };
      }
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Fixture work run is observable" } },
      };
    });

    const changes: GoalChange[] = [];
    const unsubscribe = await fixture.client.goals.subscribe("conversation", (change) =>
      changes.push(change),
    );

    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "guided-1",
      mode: "guided",
      seed: "  implemente request.md sem publicar  ",
    });
    expect(receipt.formulation).toMatchObject({ mode: "guided", outcome: "created" });
    const definitionFrame = JSON.parse(
      String(fixture.stewardRequests[0]!.messages.at(-1)!.content),
    ) as {
      normative_sources: Array<{
        path: string;
        digest: string;
        content: string;
        truncated: boolean;
      }>;
    };
    expect(definitionFrame.normative_sources).toEqual([
      {
        path: "request.md",
        content: "Implement the semantic Goal agent.\n",
        truncated: false,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const view = await fixture.client.goals.get("conversation");
    expect(view.state.current).toMatchObject({
      objective: "Implement the semantic Goal agent",
      constraints: ["Use the existing durable Goal runtime"],
      exclusions: ["Do not publish"],
      assumptions: ["request.md is the normative request"],
      sources: [{ path: "request.md", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      origin: {
        kind: "guided",
        seed: "implemente request.md sem publicar",
        formulation_execution_id: receipt.formulation.formulation_execution_id,
        formulation_usage: { kind: "measured", input: 3050, output: 30, cached: 1500 },
      },
    });
    expect(view.state.current!.runs).toHaveLength(1);
    expect(view.state.current!.runs[0]!.execution_id).not.toBe(
      receipt.formulation.formulation_execution_id,
    );
    expect(
      await fixture.host.kernel.runs.get(receipt.formulation.formulation_execution_id!),
    ).toMatchObject({ status: "completed" });
    expect(
      fixture.host.kernel
        .readRunTrace(receipt.formulation.formulation_execution_id!)
        ?.find((event) => event.type === "run_started"),
    ).toMatchObject({ type: "run_started", max_tokens: 123_456 });
    const announced = fixture.requests[0]!.tools!.map((tool) => tool.function.name).sort();
    expect(announced).toEqual([...readOnlyTools.map((tool) => tool.name), "submit_result"].sort());
    const replay = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "guided-1",
      mode: "guided",
      seed: "implemente request.md sem publicar",
    });
    expect(replay).toEqual(receipt);
    expect(
      fixture.requests.filter((request) =>
        request.tools?.some((tool) => tool.function.name === "submit_result"),
      ),
    ).toHaveLength(2);
    unsubscribe();
    expect(changes.some((change) => change.formulation_activity?.phase === "thinking")).toBeTrue();
    expect(changes.some((change) => change.formulation_activity?.phase === "reading")).toBeTrue();
    expect(
      changes.some((change) => change.formulation_activity?.phase === "searching"),
    ).toBeFalse();
    expect(
      changes.some(
        (change) =>
          change.formulation_activity?.phase === "thinking" &&
          change.formulation_activity.last_workspace_activity === "reading",
      ),
    ).toBeTrue();
    expect(changes.at(-1)?.formulation_activity?.phase).toBe("idle");
  });

  it("returns deterministic insufficient context without inference for empty auto", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "auto-empty",
      mode: "auto",
    });
    expect(receipt.formulation).toEqual({
      mode: "auto",
      outcome: "insufficient_context",
      question: "What outcome should Clarvis pursue?",
    });
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
    expect(fixture.requests).toEqual([]);
  });

  it("attests a complete normative read whose persisted trace result is abbreviated", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const content = Array.from(
      { length: 600 },
      (_, index) => `requirement ${String(index + 1)} must remain observable`,
    ).join("\n");
    await writeFile(join(fixture.workspaceRoot, "large-spec.md"), content);
    let formulationCalls = 0;
    fixture.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result")) {
        formulationCalls++;
        if (formulationCalls === 1)
          return {
            name: "read_file",
            arguments: { path: "large-spec.md", offset: 1, limit: 2000 },
          };
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Implement the complete large specification",
            criteria: [],
            constraints: [],
            exclusions: [],
            assumptions: ["large-spec.md is normative"],
            normative_source_paths: ["large-spec.md"],
          },
        };
      }
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Fixture work run is observable" } },
      };
    });

    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "large-normative-source",
      mode: "guided",
      seed: "Implement large-spec.md",
    });

    expect(receipt.formulation.outcome).toBe("created");
    expect((await fixture.client.goals.get("conversation")).state.current?.sources).toEqual([
      { path: "large-spec.md", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    const trace = fixture.host.kernel.readRunTrace(receipt.formulation.formulation_execution_id!);
    const read = trace?.find(
      (event) =>
        event.type === "tool_call" && "mcp_name" in event && event.mcp_name === "read_file",
    );
    expect(read).toMatchObject({
      type: "tool_call",
      result: expect.stringContaining("...[truncated]"),
      result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects an actually partial ranged read of a normative source", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    await writeFile(join(fixture.workspaceRoot, "partial.md"), "first line\nsecond line\n");
    fixture.setResponder(async () => {
      const formulationCalls = fixture.requests.filter((item) =>
        item.tools?.some((tool) => tool.function.name === "submit_result"),
      ).length;
      if (formulationCalls === 1)
        return { name: "read_file", arguments: { path: "partial.md", offset: 2, limit: 1 } };
      return {
        name: "submit_result",
        arguments: {
          status: "ready",
          objective: "Honor the whole normative source",
          criteria: [],
          constraints: [],
          exclusions: [],
          assumptions: [],
          normative_source_paths: ["partial.md"],
        },
      };
    });

    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "partial-source",
      mode: "guided",
      seed: "Use partial.md",
    });

    expect(receipt.formulation).toMatchObject({
      outcome: "insufficient_context",
      message: expect.stringContaining("could not be revalidated"),
    });
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
  });

  it("records a recoverable failed receipt when the semantic run returns invalid output", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    fixture.setResponder(async () => ({
      name: "submit_result",
      arguments: { status: "ready", objective: "Missing required semantic fields" },
    }));
    const request = {
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "invalid-formulation",
      mode: "guided" as const,
      seed: "Formulate this exact request",
    };

    const receipt = await fixture.client.goals.formulate(request);
    expect(receipt.formulation).toMatchObject({
      mode: "guided",
      outcome: "failed",
      message: "Goal formulation failed; try again",
      formulation_execution_id: expect.any(String),
    });
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
    const measured = fixture.usages.reduce(
      (total, usage) => ({
        input: total.input + usage.input,
        output: total.output + usage.output,
        cached: total.cached + usage.cached,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    expect((await fixture.client.sessions.get("conversation"))!.totals).toEqual(measured);
    const calls = fixture.requests.length;
    expect(await fixture.client.goals.formulate(request)).toEqual(receipt);
    expect(fixture.requests).toHaveLength(calls);
  });

  it("retains formulation and definition-review usage when review cannot produce its mode", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    fixture.setResponder(async () => ({
      name: "submit_result",
      arguments: {
        status: "ready",
        objective: "Create a reviewed goal",
        criteria: [],
        constraints: [],
        exclusions: [],
        assumptions: [],
        normative_source_paths: [],
      },
    }));
    fixture.setStewardResponder(async () => ({
      name: "submit_result",
      arguments: { decision: "aligned", summary: "Wrong review mode" },
    }));

    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "failed-definition-review",
      mode: "guided",
      seed: "Create a reviewed goal",
    });

    expect(receipt.formulation.outcome).toBe("failed");
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
    const measured = [...fixture.usages, ...fixture.stewardUsages].reduce(
      (total, usage) => ({
        input: total.input + usage.input,
        output: total.output + usage.output,
        cached: total.cached + usage.cached,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    expect((await fixture.client.sessions.get("conversation"))!.totals).toEqual(measured);
  });

  it("formulates auto from a persisted conversation trajectory and starts normal work", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    fixture.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result"))
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Apply the corrected trajectory request",
            criteria: [
              { description: "The latest corrected request is satisfied", kind: "qualitative" },
            ],
            constraints: [],
            exclusions: ["Do not publish"],
            assumptions: [],
            normative_source_paths: [],
          },
        };
      if (fixture.requests.length === 1) return { text: "Earlier conversation result" };
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Auto work run is observable" } },
      };
    });
    const before = (await fixture.client.sessions.get("conversation"))!;
    const prior = await fixture.client.hosting!.start({
      session_id: "conversation",
      session_revision: before.revision!,
      kind: "conversation",
      user_preview: "Implement the correction",
      params: {
        execution_id: "prior-conversation",
        session_id: "conversation",
        agent_instance_id: "prior-agent",
        agent: "solo",
        messages: [{ role: "user", content: "Implement the correction, but do not publish" }],
      },
    });
    for await (const frame of prior.handle.events) void frame;
    expect((await prior.handle.done).status).toBe("completed");
    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "auto-ready",
      mode: "auto",
    });
    expect(receipt.formulation).toMatchObject({ mode: "auto", outcome: "created" });
    expect((await fixture.client.goals.get("conversation")).state.current).toMatchObject({
      objective: "Apply the corrected trajectory request",
      origin: { kind: "auto", source_execution_ids: ["prior-conversation"] },
      exclusions: ["Do not publish"],
      runs: [{ execution_id: expect.any(String) }],
    });
  });

  it("records stale_context when the conversation changes during inference", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result")) {
        arrived.resolve();
        await release.promise;
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "A stale proposal",
            criteria: [],
            constraints: [],
            exclusions: [],
            assumptions: [],
            normative_source_paths: [],
          },
        };
      }
      return { text: "unexpected work run" };
    });
    const pending = fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "stale-1",
      mode: "guided",
      seed: "Formule este pedido",
    });
    await arrived.promise;
    const changed = (await fixture.client.sessions.get("conversation"))!;
    await fixture.client.sessions.save({ ...changed, title: "Changed during formulation" });
    release.resolve();
    const receipt = await pending;
    expect(receipt.formulation).toMatchObject({ mode: "guided", outcome: "stale_context" });
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
  });

  it("shares one in-process analysis for concurrent identical operation ids", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result")) {
        arrived.resolve();
        await release.promise;
        return {
          name: "submit_result",
          arguments: {
            status: "insufficient_context",
            question: "Which behavior should change?",
            reason: "The seed names no observable behavior",
          },
        };
      }
      return { text: "unexpected work run" };
    });
    const request = {
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "same-operation",
      mode: "guided" as const,
      seed: "Improve it",
    };
    const first = fixture.client.goals.formulate(request);
    await arrived.promise;
    const second = fixture.client.goals.formulate(request);
    release.resolve();
    expect(await second).toEqual(await first);
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.client.sessions.get("conversation"))!.totals).toEqual({
      input: 1010,
      output: 10,
      cached: 500,
    });
  });

  it("does not dispatch an unannounced mutating workspace tool", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const target = join(fixture.workspaceRoot, "forbidden.txt");
    fixture.setResponder(async (_request) => {
      const formulationCalls = fixture.requests.filter((item) =>
        item.tools?.some((tool) => tool.function.name === "submit_result"),
      ).length;
      if (formulationCalls === 1)
        return { name: "write_file", arguments: { path: "forbidden.txt", content: "no" } };
      return {
        name: "submit_result",
        arguments: {
          status: "insufficient_context",
          question: "Which read-only source defines the result?",
          reason: "The requested mutation is outside formulation authority",
        },
      };
    });
    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "mutating-tool",
      mode: "guided",
      seed: "Inspect the workspace and formulate the change",
    });
    expect(receipt.formulation.outcome).toBe("insufficient_context");
    expect(fixture.requests[0]!.tools!.map((tool) => tool.function.name)).not.toContain(
      "write_file",
    );
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a normative file changes after the formulation read", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const source = join(fixture.workspaceRoot, "moving.md");
    await writeFile(source, "first snapshot\n");
    fixture.setResponder(async (_request) => {
      const formulationCalls = fixture.requests.filter((item) =>
        item.tools?.some((tool) => tool.function.name === "submit_result"),
      ).length;
      if (formulationCalls === 1) return { name: "read_file", arguments: { path: "moving.md" } };
      await writeFile(source, "second snapshot\n");
      return {
        name: "submit_result",
        arguments: {
          status: "ready",
          objective: "Honor the moving source",
          criteria: [],
          constraints: [],
          exclusions: [],
          assumptions: [],
          normative_source_paths: ["moving.md"],
        },
      };
    });
    const receipt = await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "moving-source",
      mode: "guided",
      seed: "Implement moving.md",
    });
    expect(receipt.formulation).toMatchObject({
      outcome: "insufficient_context",
      message: expect.stringContaining("could not be revalidated"),
    });
    expect((await fixture.client.goals.get("conversation")).state.current).toBeUndefined();
  });

  it("blocks completion and presents drift when a normative snapshot changes", async () => {
    const fixture = await createGoalFileHostFixture();
    cleanups.push(fixture.close);
    const source = join(fixture.workspaceRoot, "contract.md");
    await writeFile(source, "original contract\n");
    const workArrived = Promise.withResolvers<void>();
    const continueWork = Promise.withResolvers<void>();
    fixture.setResponder(async (request) => {
      const tools = request.tools?.map((tool) => tool.function.name) ?? [];
      const formulationCalls = fixture.requests.filter((item) =>
        item.tools?.some((tool) => tool.function.name === "submit_result"),
      ).length;
      if (tools.includes("submit_result")) {
        if (formulationCalls === 1)
          return { name: "read_file", arguments: { path: "contract.md" } };
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Honor the normative contract",
            criteria: [{ description: "The contract is honored", kind: "qualitative" }],
            constraints: [],
            exclusions: [],
            assumptions: [],
            normative_source_paths: ["contract.md"],
          },
        };
      }
      if (
        fixture.requests.filter(
          (item) => !item.tools?.some((tool) => tool.function.name === "submit_result"),
        ).length === 1
      ) {
        workArrived.resolve();
        await continueWork.promise;
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Done",
              assessments: [
                {
                  criterion_id: "criterion-01",
                  kind: "qualitative",
                  justification: "Fixture candidate",
                },
              ],
            },
          },
        };
      }
      return { text: "Done" };
    });
    await fixture.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "drift-1",
      mode: "guided",
      seed: "Implement contract.md",
    });
    await workArrived.promise;
    await writeFile(source, "changed contract\n");
    continueWork.resolve();
    await fixture.until(
      async () =>
        (await fixture.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    const view = await fixture.client.goals.get("conversation");
    expect(view.attention).toContain("normative source changed");
    expect(view.state.current).toMatchObject({ status: "blocked" });
    await unlink(source);
    expect((await fixture.client.goals.get("conversation")).attention).toContain(
      "normative source changed",
    );
  });
});

it("preserves unknown formulation telemetry instead of charging measured zero", async () => {
  const fixture = await createGoalFileHostFixture();
  cleanups.push(fixture.close);
  fixture.setResponder(async () => ({
    name: "submit_result",
    arguments: {
      status: "insufficient_context",
      question: "Which output?",
      reason: "Need a concrete target",
    },
    usage: "missing",
  }));
  const result = await fixture.client.goals.formulate({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "missing-usage",
    mode: "guided",
    seed: "Investigate the desired output",
  });
  expect(result.formulation.outcome).toBe("insufficient_context");
  const session = await fixture.client.sessions.get("conversation");
  expect(session!.totals.input).toBe(0);
});
