import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("non-completed terminal statuses are first-class records", () => {
  it("persists an error run (empty_response)", async () => {
    const llm = new MockLLM({ script: [{}, {}] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });

    const body = res as unknown as { execution_id: string; status: string };
    expect(body.status).toBe("error");
    const stored = harness.traceStore.getById("test", body.execution_id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("error");
    expect(stored!.response.status).toBe("error");
  });

  it("persists a budget_exhausted run", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "fs.read", arguments: {} }] }],
    });
    const mcp = mockMCPFactory({ fs: { tools: [{ name: "read", call: () => "x" }] } });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "loop" }],
      servers: [{ name: "fs", transport: "stdio", command: "node", args: [] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["fs.read"],
          iteration_limit: 1,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });

    const body = res as unknown as { execution_id: string; status: string };
    expect(body.status).toBe("budget_exhausted");
    const stored = harness.traceStore.getById("test", body.execution_id);
    expect(stored!.status).toBe("budget_exhausted");
    expect(stored!.response.status).toBe("budget_exhausted");
  });
});
