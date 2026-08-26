import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("spawned Subagent iteration_limit is a hard cap even under on_exceed='escalate' (finding 12)", () => {
  it("the Subagent stops at its iteration_limit with budget_exhausted and no human is prompted", async () => {
    let elicitCalls = 0;
    const elicit: Elicit = async () => {
      elicitCalls += 1;
      return { action: "accept", content: { continue: "continue" } };
    };

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "deep search" } }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        {
          text: "searching...",
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
        {
          text: "still searching, partial: name=Jane",
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 14, output_tokens: 4 },
        },
        { text: "Best effort from the Lead.", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });

    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "nothing conclusive" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp, elicit });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract name" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 2,
        },
      ],
      budget: { on_exceed: "escalate", total_token_limit: 500000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: Array<{ type: string; iterations?: number; instances?: number }> };
    };
    expect(body.status).toBe("completed");

    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(1);
    expect(subagent.iterations).toBe(2);

    expect(elicitCalls).toBe(0);

    const seen = JSON.stringify(
      llm.calls.filter((c) => c.model === "claude-opus-4-5").at(-1)!.messages,
    );
    expect(seen).toContain("budget_exhausted");
    expect(seen).toContain("still searching, partial: name=Jane");
  });
});

describe("spawned Subagent iteration_limit is a hard cap under on_exceed='stop' too", () => {
  it("the Subagent stops at its iteration_limit with budget_exhausted and its partial output reaches the Lead", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "deep search" } }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        {
          text: "searching...",
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
        {
          text: "still searching, partial: name=Jane",
          toolCalls: [{ name: "docs.search", arguments: {} }],
          usage: { input_tokens: 14, output_tokens: 4 },
        },
        { text: "Best effort: name=Jane.", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });

    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "search", inputSchema: {}, call: () => "nothing conclusive" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract name" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["docs.search"],
          iteration_limit: 2,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: Array<{ type: string; iterations?: number; instances?: number }> };
    };
    expect(body.status).toBe("completed");

    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(1);
    expect(subagent.iterations).toBe(2);

    const seen = JSON.stringify(
      llm.calls.filter((c) => c.model === "claude-opus-4-5").at(-1)!.messages,
    );
    expect(seen).toContain("budget_exhausted");
    expect(seen).toContain("still searching, partial: name=Jane");
  });
});
