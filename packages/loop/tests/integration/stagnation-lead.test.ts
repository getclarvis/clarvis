import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead stagnation guard", () => {
  it("does not treat a repeated query separated by other calls as stagnation", async () => {
    const mcp = mockMCPFactory({
      db: {
        tools: [
          {
            name: "query",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => ({ rows: [], ok: true }),
          },
        ],
      },
    });
    const stuck = {
      toolCalls: [{ name: "db.query", arguments: { q: "select 1" } }],
      usage: { input_tokens: 12, output_tokens: 4, cached_tokens: 0 },
    };
    const probe = (n: number) => ({
      toolCalls: [{ name: "db.query", arguments: { q: `describe t${n}` } }],
      usage: { input_tokens: 12, output_tokens: 4, cached_tokens: 0 },
    });
    const llm = new MockLLM({
      script: [
        stuck,
        probe(1),
        stuck,
        probe(2),
        stuck,
        probe(3),
        { text: "investigation complete", usage: { input_tokens: 3, output_tokens: 3 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "investigate the db" }],
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
    expect((res as { error?: { code?: string } }).error?.code).not.toBe("stagnation_detected");
  });

  it("terminates when the Lead repeats the same call and result consecutively", async () => {
    const mcp = mockMCPFactory({
      db: {
        tools: [
          {
            name: "query",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => ({ rows: [], ok: true }),
          },
        ],
      },
    });
    const stuck = {
      toolCalls: [{ name: "db.query", arguments: { q: "select 1" } }],
      usage: { input_tokens: 12, output_tokens: 4, cached_tokens: 0 },
    };
    const llm = new MockLLM({ script: [stuck, stuck, stuck] });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "investigate the db" }],
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
    expect((res as { error?: { code?: string } }).error?.code).toBe("stagnation_detected");
    expect(llm.calls.length).toBeLessThanOrEqual(3);
  });
});
