import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead progress accounting — failed MCP calls", () => {
  it("failed tool calls do not count as progress: interleaved failures still trip no_progress", async () => {
    const mcp = mockMCPFactory({
      db: {
        tools: [
          {
            name: "query",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => {
              throw new Error("table missing");
            },
          },
        ],
      },
    });
    const fail = (q: string) => ({ toolCalls: [{ name: "db.query", arguments: { q } }] });
    const llm = new MockLLM({
      script: [
        { text: "thinking" },
        fail("select 1"),
        { text: "thinking again" },
        fail("select 2"),
        { text: "still thinking" },
        fail("select 3"),
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "query the db" }],
      servers: [{ name: "db", transport: "stdio", command: "x" }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["db.query"],
          iteration_limit: 50,
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
      output_schema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("no_progress");
    expect(llm.calls).toHaveLength(6);
  });
});
