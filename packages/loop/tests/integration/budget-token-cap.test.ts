import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("token cap reached", () => {
  it("terminates with budget_exhausted when input+output tokens hit the cap", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: {} }],
          usage: { input_tokens: 40, output_tokens: 20, cached_tokens: 0 },
        },
        {
          toolCalls: [{ name: "filesystem.read", arguments: {} }],
          usage: { input_tokens: 30, output_tokens: 20, cached_tokens: 0 },
        },
        {
          text: "would never be returned",
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
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
          iteration_limit: 50,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: { input_tokens: number; output_tokens: number }[] };
    };
    expect(body.status).toBe("budget_exhausted");
    const a = body.usage.by_agent[0]!;
    const total = a.input_tokens + a.output_tokens;
    expect(total).toBeLessThanOrEqual(100 + 50);
  });
});
