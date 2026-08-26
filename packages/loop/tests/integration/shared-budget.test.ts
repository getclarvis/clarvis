import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("shared budget exhausted across Lead + Subagent", () => {
  it("returns budget_exhausted with totals within the cap + bounded overshoot", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "deep dig" } }],
          usage: { input_tokens: 5, output_tokens: 5, cached_tokens: 0 },
        },
        {
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 20, output_tokens: 20 },
        },
        {
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 20, output_tokens: 20 },
        },
        {
          text: "partial findings",
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 20, output_tokens: 20 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "..." }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract everything" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          iteration_limit: 10,
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: {
        by_agent: Array<{
          type: string;
          input_tokens: number;
          output_tokens: number;
          iterations?: number;
        }>;
      };
    };
    expect(body.status).toBe("budget_exhausted");

    const lead = body.usage.by_agent.find((a) => a.type === "lead")!;
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    const total =
      lead.input_tokens + lead.output_tokens + subagent.input_tokens + subagent.output_tokens;

    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThanOrEqual(100 + 2 * 50);

    expect(lead.iterations).toBe(1);
    expect(subagent.iterations).toBe(3);
  });
});
