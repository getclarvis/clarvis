import { afterEach, describe, expect, it } from "bun:test";
import { createCapabilityRegistry, loadEnv, type LLMToolCall } from "@clarvis/capability";
import { createGoalCapability, settleGoalRun } from "@clarvis/goal";
import { executeRun } from "@clarvis/loop";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createPlanStore } from "@clarvis/plan";
import { createPlansCapability } from "@clarvis/plan/capability";
import { plansSettingsSpec } from "@clarvis/plan/settings";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { goalHostFixture } from "../helpers/goal-host.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real host port and private session persistence with manually admitted stages and controlled SDK responses. */
async function fixture(mode: "checkpoint" | "blocked" | "review") {
  const traceStore = createMemoryTraceStore();
  const host = await goalHostFixture({
    readTrace: (id) => traceStore.getById("owner", id)?.trace.events,
  });
  const { workspaceRoot } = host;
  cleanup.push(host.close);
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" });
  const connections = createConnectionManager({
    workspace: workspaceRoot,
    factory: defaultMCPClientFactory,
    connectTimeoutMs: 1000,
    callTimeoutMs: 1000,
  });
  cleanup.push(() => connections.closeAll());
  const store = createPlanStore({ repository: createInMemoryPlanRepository() });
  const wire: Array<{
    messages: unknown[];
    tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    prompt_cache_key: string;
  }> = [];
  const adapter = new AiSdkAdapter({
    fetch: Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("Expected serialized SDK body");
        wire.push(JSON.parse(init.body) as (typeof wire)[number]);
        const step = wire.length;
        let call: Omit<LLMToolCall, "id">;
        switch (step) {
          case 1:
            call = {
              name: "create_plan",
              arguments: {
                title: "Goal stage",
                objective: "Verify fixture",
                tasks: [{ title: "Verify" }],
                validation: [],
              },
            };
            break;
          case 2:
            call = {
              name: "update_goal",
              arguments: {
                update:
                  mode === "blocked"
                    ? { action: "blocked", reason: "Required authority was refused" }
                    : {
                        action: "checkpoint",
                        summary: "Plan prepared",
                        next_step: "Verify the fixture",
                      },
              },
            };
            break;
          case 3: {
            const plan = (await store.list()).plans[0]!;
            call = {
              name: "transition_plan_task",
              arguments: {
                expected_revision: plan.revision,
                expected_digest: plan.digest,
                expected_spec_digest: plan.spec_digest,
                transitions: [
                  { task_id: "t1", status: "done", result: "Synthetic fixture verified" },
                ],
              },
            };
            break;
          }
          case 4:
            call = {
              name: "update_goal",
              arguments: {
                update: {
                  action: "candidate",
                  summary: "Result verified",
                  assessments: [
                    {
                      criterion_id: "objective",
                      kind: "qualitative",
                      justification: "Observed the required synthetic result",
                    },
                  ],
                },
              },
            };
            break;
          case 5:
            call = { name: "submit_result", arguments: { verified: true } };
            break;
          default:
            throw new Error("Unexpected extra inference");
        }
        const chunk = {
          id: `response-${step}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${step}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 1000 + step * 10,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  });
  let reviewRequests = 0;
  const run = async (execution_id: string, continue_from?: string) => {
    await host.admit(execution_id);
    const { port, evidence } = await host.runtime(execution_id);
    return executeRun({
      owner: "owner",
      onEvent: (event) => evidence.observe(event),
      rawBody: {
        execution_id,
        continue_from,
        session_id: "session",
        agent_instance_id: "entry",
        messages: [
          {
            role: "user",
            content:
              continue_from === undefined
                ? "Prepare the plan and end this stage"
                : "Continue the goal and verify",
          },
        ],
        profiles: [
          { name: "solo", model: "fixture/model", tools: [], grants: [], iteration_limit: 8 },
        ],
        servers: [],
        entry: "solo",
        providers: [
          { name: "fixture", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
        ],
        budget: { total_token_limit: 100000, on_exceed: "stop" },
        plans: {
          mode: mode === "review" ? "review" : "on",
          retention: "discard",
          pending_task_nudges: 1,
        },
        output_schema: {
          type: "object",
          properties: { verified: { type: "boolean" } },
          required: ["verified"],
          additionalProperties: false,
        },
      },
      elicit: async () => {
        reviewRequests++;
        return { action: "cancel" };
      },
      deps: {
        env,
        workspaceRoot,
        connections,
        traceStore,
        llm: adapter,
        capabilityRegistry: createCapabilityRegistry({ specs: [plansSettingsSpec] }),
        capabilities: [
          createGoalCapability(port),
          createPlansCapability({
            factory: {
              storeFor: async () => ({ key: "markdown", providerKind: "markdown", store }),
            },
            defaultPendingTaskNudges: 1,
            defaultElicitWaitMs: 1000,
          }),
        ],
      },
    });
  };
  return {
    run,
    store,
    wire,
    state: () => host.repository.read("session"),
    reopened: () => host.reopen().get("session"),
    reviewRequests: () => reviewRequests,
    settleStage: () =>
      host.repository.transact("session", (state) => ({
        state: settleGoalRun(state!, {
          goal_id: state!.current!.goal_id,
          execution_id: "first",
          physical_closed: true,
          outcome: "completed",
          disposition: "checkpoint",
          usage: { kind: "measured", input: 2030, output: 20, cached: 0 },
          completion_validated: false,
          now: 500,
        }),
        result: undefined,
      })),
  };
}

describe("goal capability through real loop, plan and SDK", () => {
  it("preserves the open plan and serialized prefix through a manually admitted second stage, then applies final schema and retention", async () => {
    const f = await fixture("checkpoint");
    const first = await f.run("first");
    expect(first.response).toMatchObject({
      status: "completed",
      disposition: "checkpoint",
      checkpoint: { summary: "Plan prepared", next_step: "Verify the fixture" },
    });
    expect(first.response).not.toHaveProperty("result", expect.anything());
    const initial = (await f.store.list()).plans[0]!;
    expect(initial.status).not.toBe("completed");
    expect(initial.tasks[0]!.status).toBe("pending");
    expect(f.wire).toHaveLength(2);
    await f.settleStage();
    const second = await f.run("second", "first");
    expect(second.response).toMatchObject({ status: "completed", result: { verified: true } });
    expect((await f.store.list()).plans).toHaveLength(0);
    expect((await f.state())!.current!.status).toBe("active");
    expect((await f.state())!.current!.candidate?.assessments[0]!.kind).toBe("qualitative");
    expect((await f.reopened())!.goal_state).toEqual(await f.state());
    expect(f.wire).toHaveLength(5);
    expect(new Set(f.wire.map((request) => request.prompt_cache_key))).toEqual(
      new Set(["session_entry"]),
    );
    expect(f.wire[0]!.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["get_goal", "update_goal", "create_plan", "submit_result"]),
    );
    expect(
      f.wire[0]!.tools.find((tool) => tool.function.name === "update_goal")!.function.parameters,
    ).toMatchObject({
      type: "object",
      required: ["update"],
      additionalProperties: false,
      properties: {
        update: {
          anyOf: [
            { properties: { action: { const: "progress" } }, additionalProperties: false },
            { properties: { action: { const: "checkpoint" } }, additionalProperties: false },
            { properties: { action: { const: "candidate" } }, additionalProperties: false },
            { properties: { action: { const: "blocked" } }, additionalProperties: false },
          ],
        },
      },
    });
    for (let index = 1; index < f.wire.length; index++) {
      expect(f.wire[index]!.tools).toEqual(f.wire[index - 1]!.tools);
      const previous = f.wire[index - 1]!.messages;
      expect(f.wire[index]!.messages.slice(0, previous.length)).toEqual(previous);
    }
  });

  it.each(["blocked", "review"] as const)(
    "preserves pending tasks and discard plans when %s stops the goal stage",
    async (mode) => {
      const f = await fixture(mode);
      const result = await f.run("first");
      expect(result.response.status).not.toBe("completed");
      expect(result.response.disposition).not.toBe("checkpoint");
      expect(f.wire).toHaveLength(2);
      const plan = (await f.store.list()).plans[0]!;
      expect(plan.status).not.toBe("completed");
      expect(plan.tasks[0]!.status).toBe("pending");
      expect(f.reviewRequests()).toBe(mode === "review" ? 1 : 0);
      if (mode === "blocked")
        expect(result.response).toMatchObject({ status: "error", error: { code: "goal_blocked" } });
    },
  );
});
