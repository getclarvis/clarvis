import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("multi-iteration tool calling", () => {
  it("executes list -> read sequence and aggregates the answer", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.list", arguments: { dir: "/tmp" } }],
          usage: { input_tokens: 30, output_tokens: 10, cached_tokens: 0 },
        },
        {
          toolCalls: [{ name: "filesystem.read", arguments: { path: "/tmp/big.txt" } }],
          usage: { input_tokens: 30, output_tokens: 10, cached_tokens: 0 },
        },
        {
          text: "The largest file in /tmp is big.txt; it contains 'hello world'.",
          usage: { input_tokens: 30, output_tokens: 20, cached_tokens: 0 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: {
        tools: [
          {
            name: "list",
            inputSchema: { type: "object" },
            call: () => ["small.txt", "big.txt"],
          },
          {
            name: "read",
            inputSchema: { type: "object" },
            call: () => "hello world",
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "list /tmp and read the largest file" }],
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.list", "filesystem.read"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      result: string;
      usage: { iterations_used: number };
    };
    expect(body.status).toBe("completed");
    expect(body.result).toContain("hello world");
    expect(body.usage.iterations_used).toBe(3);
  });
});
