import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("consecutive failures + lead.max_iterations reached → budget_exhausted", () => {
  it("returns status:budget_exhausted with the Lead's last message as result", async () => {
    const llm = new MockLLM({
      script: [
        {
          text: "Trying strategy 1.",
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "strategy 1" } }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        { usage: { input_tokens: 10, output_tokens: 0 } },
        { usage: { input_tokens: 10, output_tokens: 0 } },
        {
          text: "Trying strategy 2.",
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "strategy 2" } }],
          usage: { input_tokens: 18, output_tokens: 8 },
        },
        { usage: { input_tokens: 10, output_tokens: 0 } },
        { usage: { input_tokens: 10, output_tokens: 0 } },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "find the answer" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 2,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      result: string;
      usage: { by_agent: Array<{ type: string; iterations?: number }> };
    };
    expect(body.status).toBe("budget_exhausted");
    expect(body.result).toBe("Trying strategy 2.");

    const lead = body.usage.by_agent.find((a) => a.type === "lead") as { iterations: number };
    expect(lead.iterations).toBe(2);
  });
});
