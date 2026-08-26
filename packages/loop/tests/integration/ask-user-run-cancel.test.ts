import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { createAskUserCapability } from "../../src/runtime/capabilities/ask-user.ts";
import { loadEnv } from "@clarvis/capability";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { MockLLM, mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { TEST_PROVIDERS } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/index.ts";

describe("run cancellation interrupts a pending question", () => {
  it("cancel while the elicitation is pending → cancelled terminal + partial, persisted", async () => {
    const traceStore = makeTestTraceStore();
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "ask_user", arguments: { question: "are you sure?" } }] }],
    });
    const ext = new AbortController();

    let elicitStarted!: () => void;
    const started = new Promise<void>((r) => {
      elicitStarted = r;
    });

    const elicit: Elicit = (_params, opts) =>
      new Promise((_resolve, reject) => {
        elicitStarted();
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const deps: ExecuteRunDeps = {
      env: loadEnv({}),
      llm,
      connections: mockConnections(mockMCPFactory({})),
      traceStore,
      workspaceRoot: process.cwd(),
      capabilities: [createAskUserCapability()],
    };

    const runP = executeRun({
      rawBody: {
        execution_id: "exec_ask_cancel",
        providers: TEST_PROVIDERS,
        messages: [{ role: "user", content: "hi" }],
        servers: [],
        profiles: [
          {
            name: "solo",
            model: "anthropic/x",
            tools: [],
            iteration_limit: 10,
            grants: ["ask_user"],
          },
        ],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 100_000 },
      },
      owner: "test",
      deps,
      externalSignal: ext.signal,
      elicit,
    });

    await started;
    ext.abort({ source: "mcp" });

    const { response } = await runP;
    expect(response.status).toBe("cancelled");
    expect(response.usage).toBeDefined();

    const row = traceStore.getById("test", "exec_ask_cancel");
    expect(row?.status).toBe("cancelled");
    expect(row?.response.status).toBe("cancelled");
  });
});
