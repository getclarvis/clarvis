import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead retries with a materially different strategy after a Subagent reports 'not found'", () => {
  it("spawns a second Subagent with a different task rather than terminating", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", task: "Search for 'plaintiff' by English keyword" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        { text: "not found", usage: { input_tokens: 15, output_tokens: 5 } },
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", task: "Search for 'autor' using the Portuguese legal term" },
            },
          ],
          usage: { input_tokens: 18, output_tokens: 8 },
        },
        { text: "Plaintiff: Jane Doe", usage: { input_tokens: 16, output_tokens: 6 } },
        { text: "Plaintiff is Jane Doe.", usage: { input_tokens: 12, output_tokens: 4 } },
      ],
    });

    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "Find the plaintiff" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
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
      usage: { by_agent: Array<{ type: string; instances?: number }> };
    };
    expect(body.status).toBe("completed");

    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(2);

    const subagentTasks = llm.calls
      .filter((c) => c.model === "claude-haiku-4-5")
      .map((c) => c.messages.find((m) => m.role === "user")!.content);
    expect(subagentTasks).toHaveLength(2);
    expect(subagentTasks[0]).not.toBe(subagentTasks[1]);
    expect(subagentTasks[1]).toContain("autor");
  });
});
