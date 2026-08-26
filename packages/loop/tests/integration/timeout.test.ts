import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("timeout", () => {
  it("returns status:'error' with code:'timeout' and elapsed_ms in details", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: {} }],
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
          delayMs: 2000,
        },
      ],
    });
    const mcp = mockMCPFactory({
      filesystem: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const t0 = Date.now();
    const res = await harness.run({
      messages: [{ role: "user", content: "slow" }],
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
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 200 },
    });
    const realElapsed = Date.now() - t0;

    const body = res as unknown as {
      status: string;
      error: { code: string; message: string; details?: { elapsed_ms?: number } };
      usage: { elapsed_ms: number };
    };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("timeout");
    expect(realElapsed).toBeLessThan(2000);
    expect(body.usage.elapsed_ms).toBeGreaterThanOrEqual(200);
  });
});
