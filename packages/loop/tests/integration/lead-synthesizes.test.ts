import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead synthesizes a final answer from a successful Subagent", () => {
  it("ignores surplus spawn arguments and returns the Lead's synthesized answer", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: {
                title: "w",
                task: "Find the Tax ID",
                task_id: "independent",
                provider_metadata: { ignored: true },
              },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
        { text: "Tax ID: TAX-0001", usage: { input_tokens: 40, output_tokens: 15 } },
        { text: "Done. Tax ID is TAX-0001.", usage: { input_tokens: 30, output_tokens: 10 } },
      ],
    });

    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "ok" }] },
    });

    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "Find the Tax ID in the process" }],
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
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Done. Tax ID is TAX-0001.");
  });
});
