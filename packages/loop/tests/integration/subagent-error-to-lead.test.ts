import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM } from "./_fixtures.ts";
import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const flakyFactory: MCPClientFactory = async (): Promise<MCPClientHandle> => {
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
  return {
    client: client as any,
    close: async (): Promise<void> => {},
  };
};

describe("terminal Subagent error returned as a tool result; the run continues", () => {
  it("surfaces the Subagent error to the Lead and completes the run", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "spawn_subagent", arguments: { title: "w", task: "use the flaky MCP" } },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        {
          toolCalls: [{ name: "flaky.search", arguments: {} }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
        {
          toolCalls: [{ name: "flaky.search", arguments: { retry: true } }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
        {
          text: "Could not retrieve data; reporting the failure.",
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: flakyFactory });

    const res = await harness.run({
      messages: [{ role: "user", content: "fetch it" }],
      servers: [
        {
          name: "flaky",
          transport: "stdio",
          command: "mock-server",
        },
      ],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["flaky.search"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string };
    expect(body.status).toBe("completed");

    const seen = JSON.stringify(
      llm.calls.filter((c) => c.model === "claude-opus-4-5").at(-1)!.messages,
    );
    expect(seen).toContain("Sub-agent error: code=all_tools_unavailable");
  });
});
