import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { GateLLM } from "./_gate-llm.ts";
import { TEST_PROVIDERS } from "./_helpers.ts";
import type { LLMProvider } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";

function makeDeps(llm: LLMProvider, traceStore: TraceStore): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm,
    connections: mockConnections(mockMCPFactory({})),
    traceStore,
    workspaceRoot: process.cwd(),
  };
}

describe("cancellation propagates across a Lead+Subagent run", () => {
  it("a cancelled Lead stops and any spawned Subagent does NO LLM work", async () => {
    const llm = new GateLLM((i) =>
      i === 0
        ? {
            toolCalls: [
              { id: "s0", name: "spawn_subagent", arguments: { title: "w", task: "do x" } },
            ],
          }
        : {},
    );
    const traceStore = makeTestTraceStore();
    const id = "exec_cancel_prop_1";
    const ext = new AbortController();

    const runP = executeRun({
      rawBody: {
        execution_id: id,
        messages: [{ role: "user", content: "orchestrate" }],
        servers: [],
        entry: "lead",
        providers: TEST_PROVIDERS,
        profiles: [
          {
            name: "lead",
            model: "anthropic/lead",
            tools: [],
            iteration_limit: 5,
            can_spawn: ["subagent"],
          },
          { name: "subagent", model: "anthropic/wkr", tools: [], iteration_limit: 5 },
        ],
        budget: { on_exceed: "stop", total_token_limit: 200_000 },
      },
      owner: "test",
      deps: makeDeps(llm, traceStore),
      externalSignal: ext.signal,
    });

    await llm.started(0);
    ext.abort({ source: "mcp" });

    llm.release(0);
    const { response } = await runP;

    expect(response.status).toBe("cancelled");
    expect(llm.calls.length).toBe(1);

    const got = traceStore.getById("test", id);
    expect(got?.status).toBe("cancelled");
    const events = got!.trace.events;
    expect(events.some((e) => e.type === "cancellation")).toBe(true);
  });
});
