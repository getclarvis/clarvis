import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("happy path — single tool call", () => {
  it("returns status:'completed' with non-empty result and populated usage", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }],
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 5 },
        },
        {
          text: "The hostname is 'my-host'.",
          usage: { input_tokens: 50, output_tokens: 30, cached_tokens: 0 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: {
        tools: [
          {
            name: "read",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            call: () => "my-host\n",
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "Read /etc/hostname" }],
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 10,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    expect(res).toMatchObject({
      status: "completed",
      result: "The hostname is 'my-host'.",
    });
    const body = res as unknown as { usage: { iterations_used: number; by_agent: unknown[] } };
    expect(body.usage.iterations_used).toBe(2);
    expect(body.usage.by_agent).toHaveLength(1);
    expect(body.usage.by_agent[0]).toMatchObject({
      type: "subagent",
      model: "anthropic/claude-sonnet-4-5",
      input_tokens: 150,
      output_tokens: 50,
      cached_tokens: 5,
    });
    expect(llm.calls).toHaveLength(2);
  });
});
