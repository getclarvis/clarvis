import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import type { LLMProvider } from "@clarvis/capability";
import type { MCPClientFactory } from "@clarvis/mcp-client";
import { mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, TEST_PROVIDERS, type TestHarness } from "./_helpers.ts";
import { validateBody } from "../../src/validation/index.ts";
import { loadEnv } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("cross-provider Lead/Subagent is ACCEPTED", () => {
  const env = loadEnv({});

  const make = (leadModel: string, subagentModel: string, providers?: unknown) => ({
    messages: [{ role: "user", content: "hi" }],
    servers: [],
    ...(providers ? { providers } : {}),
    entry: "lead",
    profiles: [
      { name: "lead", model: leadModel, iteration_limit: 5, tools: [], can_spawn: ["subagent"] },
      { name: "subagent", model: subagentModel, tools: [], iteration_limit: 5 },
    ],
    budget: { on_exceed: "stop", total_token_limit: 1000 },
  });

  it("accepts a Lead and Subagent on different built-in providers", () => {
    const { request } = validateBody(
      make("anthropic/claude-opus-4-5", "openai/gpt-4o", TEST_PROVIDERS),
      env,
    );
    expect(request.profiles.map((p) => p.model)).toEqual([
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ]);
    expect(request.providers.map((p) => p.name)).toEqual(TEST_PROVIDERS.map((p) => p.name));
  });

  it("accepts Lead and Subagent on different registry providers (keys optional)", () => {
    const providers = [
      {
        name: "together",
        kind: "openai-compatible",
        base_url: "https://api.together.xyz/v1",
        api_key_env: "TOGETHER_KEY",
      },
      {
        name: "deepinfra",
        kind: "openai-compatible",
        base_url: "https://api.deepinfra.com/v1/openai",
        api_key_env: "DEEPINFRA_KEY",
      },
    ];
    const { request } = validateBody(
      make("together/zai-org/GLM-5.2", "deepinfra/deepseek-ai/DeepSeek-V4-Pro", providers),
      env,
    );
    expect(request.profiles.map((p) => p.model)).toEqual([
      "together/zai-org/GLM-5.2",
      "deepinfra/deepseek-ai/DeepSeek-V4-Pro",
    ]);
    expect(request.providers.map((p) => p.name)).toEqual(["together", "deepinfra"]);
  });
});

describe("an unknown provider is rejected pre-execution (zero LLM/MCP calls)", () => {
  it("rejects unknown_provider before any LLM or MCP work", async () => {
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
        entry: "lead",
        profiles: [
          {
            name: "lead",
            model: "anthropic/claude-opus-4-5",
            iteration_limit: 5,
            tools: [],
            can_spawn: ["subagent"],
          },
          { name: "subagent", model: "madeup/model-x", tools: [], iteration_limit: 5 },
        ],
        budget: { on_exceed: "stop", total_token_limit: 1000 },
      }),
    ).rejects.toMatchObject({ code: "unknown_provider" });

    expect(llmCall).not.toHaveBeenCalled();
    expect(mcpFactoryFn).not.toHaveBeenCalled();
  });
});
