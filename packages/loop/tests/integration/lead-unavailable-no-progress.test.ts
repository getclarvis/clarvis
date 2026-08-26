import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM } from "./_fixtures.ts";
import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const flakyLeadFactory: MCPClientFactory = async (): Promise<MCPClientHandle> => {
  const client = {
    async listTools(): Promise<{
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    }> {
      return { tools: [{ name: "search", inputSchema: { type: "object" } }] };
    },
    async callTool(): Promise<unknown> {
      throw new Error("connection refused");
    },
    async close(): Promise<void> {},
  };
  return { client: client as any, close: async (): Promise<void> => {} };
};

describe("Lead all_tools_unavailable", () => {
  it("terminates the run when the Lead's only tool is unavailable and no subagent tool exists", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "flaky.search", arguments: { q: "x" } }],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
        {
          toolCalls: [{ name: "flaky.search", arguments: { q: "x again" } }],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
        { text: "should not be reached", usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: flakyLeadFactory });

    const res = await harness.run({
      messages: [{ role: "user", content: "search it" }],
      servers: [{ name: "flaky", transport: "stdio", command: "x" }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 50,
          tools: ["flaky.search"],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("all_tools_unavailable");
    expect(llm.calls.length).toBeLessThanOrEqual(2);
  });
});
