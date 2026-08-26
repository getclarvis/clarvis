import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("a ['lead','subagent'] tool is reachable by both roles", () => {
  it("appears in the Lead's tool set and resolves for a spawned Subagent", async () => {
    let queryCalls = 0;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "shared.query", arguments: {} }],
          usage: { input_tokens: 20, output_tokens: 8 },
        },
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", task: "extract" },
            },
          ],
          usage: { input_tokens: 18, output_tokens: 7 },
        },
        {
          toolCalls: [{ name: "shared.query", arguments: {} }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
        { text: "subagent found it", usage: { input_tokens: 12, output_tokens: 4 } },
        { text: "final", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });
    const mcp = mockMCPFactory({
      shared: {
        tools: [
          {
            name: "query",
            inputSchema: {},
            call: () => {
              queryCalls += 1;
              return "data";
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [
        {
          name: "shared",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["shared.query"],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["shared.query"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: Array<{ type: string; instances?: number }> };
    };
    expect(body.status).toBe("completed");

    const leadTools = llm.calls
      .filter((c) => c.model === "claude-opus-4-5")[0]!
      .tools.map((t) => t.fullName);
    expect(leadTools).toContain("shared.query");

    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(1);
    expect(queryCalls).toBe(2);
  });
});

describe("a Lead-only tool is unavailable to the spawned Subagent", () => {
  it("the spawned Subagent's tool set excludes a tool routed only to the Lead", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "do it" } }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        { text: "subagent done", usage: { input_tokens: 10, output_tokens: 4 } },
        { text: "final", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });
    const mcp = mockMCPFactory({
      leadonly: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [
        {
          name: "leadonly",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["leadonly.read"],
          can_spawn: ["subagent"],
          iteration_limit: 5,
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      usage: { by_agent: Array<{ type: string; instances?: number }> };
    };
    expect(body.status).toBe("completed");

    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(1);

    const subagentCalls = llm.calls.filter((c) => c.model === "claude-haiku-4-5");
    expect(subagentCalls.length).toBeGreaterThan(0);
    expect(subagentCalls.every((c) => c.tools.every((t) => t.fullName !== "leadonly.read"))).toBe(
      true,
    );

    const leadTools = llm.calls
      .filter((c) => c.model === "claude-opus-4-5")[0]!
      .tools.map((t) => t.fullName);
    expect(leadTools).toContain("leadonly.read");
  });
});

describe("a subagent-only tool is absent from the Lead's tool list", () => {
  it("the Lead's tool set excludes a tool routed only to the subagent profile", async () => {
    const llm = new MockLLM({
      script: [{ text: "answer", usage: { input_tokens: 10, output_tokens: 5 } }],
    });
    const mcp = mockMCPFactory({
      secret: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [
        {
          name: "secret",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 5,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["secret.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const leadTools = llm.calls
      .filter((c) => c.model === "claude-opus-4-5")[0]!
      .tools.map((t) => t.fullName);
    expect(leadTools).toContain("spawn_subagent");
    expect(leadTools).not.toContain("secret.read");
  });
});
