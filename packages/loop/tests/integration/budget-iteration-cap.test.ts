import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("iteration cap reached", () => {
  it("returns status:'budget_exhausted' with iterations_used exactly at the cap", async () => {
    const tool = (name: string) => ({ name, arguments: { x: 1 } });
    const llm = new MockLLM({
      script: [
        { toolCalls: [tool("filesystem.read")] },
        { toolCalls: [tool("filesystem.read")] },
        { toolCalls: [tool("filesystem.read")] },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: {
        tools: [{ name: "read", inputSchema: {}, call: () => "x" }],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "read many files" }],
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
          iteration_limit: 2,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      result: string;
      usage: { iterations_used: number };
    };
    expect(body.status).toBe("budget_exhausted");
    expect(body.usage.iterations_used).toBe(2);
    expect(typeof body.result).toBe("string");
    expect(llm.calls).toHaveLength(2);
  });
});
