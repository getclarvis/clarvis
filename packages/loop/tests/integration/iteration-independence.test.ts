import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("per-agent iteration caps are independent", () => {
  it("Subagent iterations do not count against lead.max_iterations", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "multi-step" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        {
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
        {
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
        { text: "subagent done", usage: { input_tokens: 8, output_tokens: 3 } },
        { text: "final", usage: { input_tokens: 6, output_tokens: 2 } },
      ],
    });
    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 2,
          tools: [],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { iterations_used: number; by_agent: Array<{ type: string; iterations?: number }> };
    };
    expect(body.status).toBe("completed");

    const lead = body.usage.by_agent.find((a) => a.type === "lead") as { iterations: number };
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent") as {
      iterations: number;
    };
    expect(lead.iterations).toBe(2);
    expect(subagent.iterations).toBe(3);
    expect(body.usage.iterations_used).toBe(5);
  });
});
