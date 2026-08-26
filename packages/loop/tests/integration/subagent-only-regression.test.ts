import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Subagent-only request behaves exactly as a single-agent run", () => {
  it("injects no child-spawn tools and returns a single byte-identical subagent entry", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "fs.read", arguments: {} }],
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 5, cache_write_tokens: 0 },
        },
        {
          text: "the answer",
          usage: { input_tokens: 50, output_tokens: 30, cached_tokens: 0, cache_write_tokens: 0 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      fs: { tools: [{ name: "read", inputSchema: {}, call: () => "data" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: [{ name: "fs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["fs.read"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      execution_id: string;
      status: string;
      result: string;
      usage: { iterations_used: number; by_agent: Array<Record<string, unknown>> };
    };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("the answer");
    expect(typeof body.execution_id).toBe("string");
    expect(body.execution_id.startsWith("exec_")).toBe(true);

    expect(body.usage.by_agent).toHaveLength(1);
    expect(body.usage.by_agent[0]).toEqual({
      type: "subagent",
      model: "anthropic/claude-sonnet-4-5",
      input_tokens: 150,
      output_tokens: 50,
      cached_tokens: 5,
      cache_write_tokens: 0,
    });
    expect(body.usage.iterations_used).toBe(2);

    for (const call of llm.calls) {
      expect(call.tools.every((t) => t.fullName !== "delegate_task")).toBe(true);
      expect(call.tools.every((t) => t.fullName !== "spawn_subagent")).toBe(true);
    }
  });
});
