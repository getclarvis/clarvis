import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { ProviderError } from "@clarvis/capability";
import type { LLMProvider, LLMCallParams, LLMCallResult } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("by_agent has lead + subagent; iterations_used = sum", () => {
  it("aggregates per-agent tokens/iterations and sums iterations_used", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "find it" } }],
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 5, cache_write_tokens: 0 },
        },
        {
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 60, output_tokens: 15, cached_tokens: 0, cache_write_tokens: 0 },
        },
        {
          text: "subagent answer",
          usage: { input_tokens: 40, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
        },
        {
          text: "lead final",
          usage: { input_tokens: 50, output_tokens: 10, cached_tokens: 3, cache_write_tokens: 0 },
        },
      ],
    });

    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "hit" }] },
    });

    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: {
        iterations_used: number;
        elapsed_ms: number;
        by_agent: Array<{
          type: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cached_tokens: number;
          cache_write_tokens: number;
          iterations?: number;
          subagents_spawned?: number;
          instances?: number;
        }>;
      };
    };
    expect(body.status).toBe("completed");

    const lead = body.usage.by_agent.find((a) => a.type === "lead")!;
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;

    expect(lead).toMatchObject({
      type: "lead",
      model: "anthropic/claude-opus-4-5",
      input_tokens: 150,
      output_tokens: 30,
      cached_tokens: 8,
      cache_write_tokens: 0,
      iterations: 2,
      subagents_spawned: 1,
    });
    expect(subagent).toMatchObject({
      type: "subagent",
      model: "anthropic/claude-haiku-4-5",
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 0,
      cache_write_tokens: 0,
      iterations: 2,
      instances: 1,
    });

    expect(body.usage.iterations_used).toBe(4);
    expect(typeof body.usage.elapsed_ms).toBe("number");
  });
});

describe("by_agent folds a throwing Subagent's partial usage", () => {
  it("a Subagent that errors after consuming tokens still contributes to by_agent", async () => {
    let subagentCalls = 0;
    let leadCalls = 0;
    const usage = { input_tokens: 30, output_tokens: 10, cached_tokens: 0, cache_write_tokens: 0 };
    const provider: LLMProvider = {
      async call(p: LLMCallParams): Promise<LLMCallResult> {
        if (p.model.includes("haiku")) {
          subagentCalls += 1;
          if (subagentCalls === 1) {
            return { toolCalls: [{ id: "w1", name: "docs.search", arguments: {} }], usage };
          }
          throw new ProviderError("upstream 500", { kind: "transient", status: 500 });
        }
        leadCalls += 1;
        if (leadCalls === 1) {
          return {
            toolCalls: [
              { id: "s1", name: "spawn_subagent", arguments: { title: "w", task: "go" } },
            ],
            usage,
          };
        }
        return { text: "lead done", usage };
      },
    };
    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "hit" }] },
    });
    harness = await makeHarness({ llm: provider, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: {
        by_agent: Array<{
          type: string;
          input_tokens: number;
          output_tokens: number;
          iterations?: number;
          instances?: number;
        }>;
      };
    };
    expect(body.status).toBe("completed");
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.input_tokens).toBe(30);
    expect(subagent.output_tokens).toBe(10);
    expect(subagent.iterations).toBe(2);
    expect(subagent.instances).toBe(1);
  });
});
