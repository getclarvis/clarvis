import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("mixed success/failure across parallel Subagents all returned to the Lead", () => {
  it("returns both a success and a failure tool result to the Lead for synthesis", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "s0", name: "spawn_subagent", arguments: { title: "w", task: "field A" } },
            { id: "s1", name: "spawn_subagent", arguments: { title: "w", task: "field B" } },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        { text: "found it", usage: { input_tokens: 15, output_tokens: 5 } },
        { usage: { input_tokens: 12, output_tokens: 0 } },
        { usage: { input_tokens: 12, output_tokens: 0 } },
        { text: "final", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract A and B" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: Array<{ type: string; instances?: number }> };
    };
    expect(body.status).toBe("completed");
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(2);

    const leadCalls = llm.calls.filter((c) => c.model === "claude-opus-4-5");
    const seen = JSON.stringify(leadCalls.at(-1)!.messages);
    expect(seen).toContain("found it");
    expect(seen).toContain("Sub-agent error: code=empty_response");
  });
});
