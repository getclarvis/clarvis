import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("MCP runtime error during execution", () => {
  it("tool error is passed back to the LLM as a tool result; final status is completed", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: { path: "/no" } }],
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
        },
        {
          text: "I couldn't read /no — file not found.",
          usage: { input_tokens: 20, output_tokens: 10, cached_tokens: 0 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: {
        tools: [
          {
            name: "read",
            inputSchema: {},
            call: () => {
              throw new Error("file not found");
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "read /no" }],
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
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("file not found");
  });
});
