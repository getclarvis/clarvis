import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("mcp_connection_failed", () => {
  it("MCP connect timeout returns status:error code:mcp_connection_failed with mcp_name", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      dead: {
        tools: [],
        connectDelayMs: 5000,
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
      servers: [
        {
          name: "dead",
          transport: "stdio",
          command: "dead-server",
        },
      ],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      error: { code: string; details?: { mcp_name?: string; transport?: string } };
      usage: { iterations_used: number; by_agent: unknown[] };
    };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("mcp_connection_failed");
    expect(body.error.details?.mcp_name).toBe("dead");
    expect(body.error.details?.transport).toBe("stdio");
    expect(body.usage.iterations_used).toBe(0);
    expect(body.usage.by_agent).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("MCP connect error returns the same shape", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      broken: {
        tools: [],
        connectError: new Error("connection refused"),
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
      servers: [
        {
          name: "broken",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      error: { code: string; details?: { mcp_name?: string; transport?: string } };
      usage: { iterations_used: number; by_agent: unknown[] };
    };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("mcp_connection_failed");
    expect(body.error.details?.mcp_name).toBe("broken");
    expect(body.error.details?.transport).toBe("stdio");
    expect(body.usage.iterations_used).toBe(0);
    expect(body.usage.by_agent).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
