import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { GateLLM } from "./_gate-llm.ts";
import { TEST_PROVIDERS } from "./_helpers.ts";
import type { LLMProvider } from "@clarvis/capability";

function makeDeps(llm: LLMProvider, traceStore = makeTestTraceStore()): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm,
    connections: mockConnections(mockMCPFactory({})),
    traceStore,
    workspaceRoot: process.cwd(),
  };
}

const RUN_BODY = {
  execution_id: "exec_mcp_cancel_1",
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 20 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 200_000 },
  providers: TEST_PROVIDERS,
};

describe("MCP cancellation via externalSignal", () => {
  it("aborting externalSignal mid-run yields a cancelled terminal, persisted with the partial + trace event", async () => {
    const llm = new GateLLM();
    const traceStore = makeTestTraceStore();
    const ext = new AbortController();

    const runP = executeRun({
      rawBody: RUN_BODY,
      owner: "test",
      deps: makeDeps(llm, traceStore),
      externalSignal: ext.signal,
    });

    await llm.started(0);
    ext.abort({ source: "mcp" });
    llm.release(0);

    const { executionId, response } = await runP;
    expect(executionId).toBe("exec_mcp_cancel_1");
    expect(response.status).toBe("cancelled");
    expect(response.usage).toBeDefined();
    expect(llm.calls.length).toBe(1);

    const row = traceStore.getById("test", "exec_mcp_cancel_1");
    expect(row?.status).toBe("cancelled");
    expect(row?.response.status).toBe("cancelled");
    expect(
      row?.trace.events.some(
        (e) => e.type === "cancellation" && (e as { reason?: string }).reason === "mcp",
      ),
    ).toBe(true);
  });

  it("a never-aborted externalSignal runs to completion; a late abort after completion is ignored", async () => {
    const llm = new GateLLM(() => ({ text: "done", toolCalls: [] }));
    const traceStore = makeTestTraceStore();
    const ext = new AbortController();

    const runP = executeRun({
      rawBody: { ...RUN_BODY, execution_id: "exec_mcp_done_1" },
      owner: "test",
      deps: makeDeps(llm, traceStore),
      externalSignal: ext.signal,
    });
    await llm.started(0);
    llm.release(0);
    const { response } = await runP;
    expect(response.status).toBe("completed");

    ext.abort({ source: "mcp" });
    const row = traceStore.getById("test", "exec_mcp_done_1");
    expect(row?.status).toBe("completed");
    expect(row?.response.status).toBe("completed");
    expect(row?.trace.events.some((e) => e.type === "cancellation")).toBe(false);
  });
});
