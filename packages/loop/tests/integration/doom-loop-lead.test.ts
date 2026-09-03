import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead doom-loop guard", () => {
  it("terminates with tool_failure_loop when the Lead repeats an identical failing MCP call", async () => {
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
    const leadFailingCall = {
      toolCalls: [{ name: "db.query", arguments: { q: "select 1" } }],
      usage: { input_tokens: 12, output_tokens: 4, cached_tokens: 0 },
    };
    const llm = new MockLLM({
      script: [leadFailingCall, leadFailingCall, leadFailingCall, leadFailingCall],
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
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("tool_failure_loop");
    expect(llm.calls.length).toBeLessThanOrEqual(4);
  });

  it("lets a later successful call in the same batch reset six genuine failures", async () => {
    const mcp = mockMCPFactory({
      db: {
        tools: [
          {
            name: "query",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: (args) => {
              if ((args as { q?: string }).q === "ok") return "recovered";
              throw new Error("table missing");
            },
          },
        ],
      },
    });
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            ...Array.from({ length: 6 }, (_, index) => ({
              id: `fail-${index}`,
              name: "db.query",
              arguments: { q: `fail-${index}` },
            })),
            { id: "ok", name: "db.query", arguments: { q: "ok" } },
          ],
        },
        { text: "done" },
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
    });

    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
  });
});
