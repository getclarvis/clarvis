import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import type { LLMProvider } from "@clarvis/capability";
import type { MCPClientFactory } from "@clarvis/mcp-client";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("lead agent acceptance", () => {
  it("lead + duplicate profile names rejects with duplicate_profile_name, zero LLM/MCP calls", async () => {
    const llmCall = vi.fn();
    const llm: LLMProvider = { call: llmCall };
    const mcpFactoryFn = vi.fn();
    const mcp: MCPClientFactory = (tool) => mcpFactoryFn(tool);
    const realFactory = mockMCPFactory({});
    mcpFactoryFn.mockImplementation((tool) => realFactory(tool));

    harness = await makeHarness({ llm, mcpFactory: mcp });

    await expect(
      harness.run({
        messages: [{ role: "user", content: "hi" }],
        servers: [],
        profiles: [
          {
            name: "lead",
            model: "anthropic/claude-sonnet-4-5",
            iteration_limit: 5,
            tools: [],
            can_spawn: ["dup"],
          },
          { name: "dup", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
          { name: "dup", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
        ],
        entry: "lead",
        budget: { on_exceed: "stop", total_token_limit: 1000 },
      }),
    ).rejects.toMatchObject({ code: "duplicate_profile_name" });

    expect(llmCall).not.toHaveBeenCalled();
    expect(mcpFactoryFn).not.toHaveBeenCalled();
  });

  it("valid lead + subagent pair is accepted (Lead answers directly, no spawn)", async () => {
    const llm = new MockLLM({
      script: [
        { text: "Direct answer from the Lead.", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 5,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });

    const body = res as unknown as {
      status: string;
      result: string;
      usage: { by_agent: Array<{ type: string; instances?: number }> };
    };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Direct answer from the Lead.");
    expect(body.usage.by_agent.map((a) => a.type)).toEqual(["lead", "subagent"]);
    const subagentEntry = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagentEntry.instances).toBe(0);
  });
});
