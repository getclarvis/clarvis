import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function closeTrackingFactory(closed: Set<string>, failName: string): MCPClientFactory {
  return async (tool): Promise<MCPClientHandle> => {
    if (tool.name === failName) throw new Error("connection refused");
    const mark = (): void => void closed.add(tool.name);
    return {
      client: {
        async listTools() {
          return { tools: [] };
        },
        async close() {
          mark();
        },
      } as any,
      close: async () => mark(),
    };
  };
}

describe("orchestrator — degraded startup with a mid-array connect failure", () => {
  it("proceeds with the servers that connected and leaks none of them", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const closed = new Set<string>();
    harness = await makeHarness({ llm, mcpFactory: closeTrackingFactory(closed, "b") });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
      servers: [
        { name: "a", transport: "stdio", command: "x" },
        { name: "b", transport: "stdio", command: "x" },
        { name: "c", transport: "stdio", command: "x" },
      ],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string };
    expect(body.status).toBe("completed");
    expect(llm.calls).toHaveLength(1);

    await harness.close();
    harness = null;
    expect(closed.has("a")).toBe(true);
    expect(closed.has("c")).toBe(true);
    expect(closed.has("b")).toBe(false);
  });
});
