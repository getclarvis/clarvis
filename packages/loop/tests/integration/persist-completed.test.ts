import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("completed execution persists before responding", () => {
  it("stores a row with matching id, owner, request, response, and trace", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "fs.read", arguments: { path: "/a" } }],
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 5, cache_write_tokens: 8 },
        },
        {
          text: "the answer",
          usage: { input_tokens: 50, output_tokens: 30, cached_tokens: 0, cache_write_tokens: 2 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      fs: { tools: [{ name: "read", call: () => "file-contents" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: [{ name: "fs", transport: "stdio", command: "node", args: [] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["fs.read"],
          iteration_limit: 10,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });

    const executionId = res.execution_id;

    const stored = harness.traceStore.getById("test", executionId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("completed");
    expect(stored!.owner_key_name).toBe("test");
    expect(stored!.response.status).toBe("completed");
    expect(stored!.request.messages[0]!.content).toBe("read it");
    expect(stored!.total_input_tokens).toBe(150);
    expect(stored!.total_output_tokens).toBe(50);
    expect(stored!.total_cached_tokens).toBe(5);
    expect(stored!.total_cache_write_tokens).toBe(10);
    const types = stored!.trace.events.map((e) => e.type);
    expect(types).toContain("subagent_iteration");
    expect(types).toContain("tool_call");
    const toolCall = stored!.trace.events.find((e) => e.type === "tool_call");
    expect(toolCall && "result" in toolCall ? toolCall.result : "").toContain("file-contents");
    expect(stored!.started_at).toBeGreaterThan(1_600_000_000_000);
  });
});
