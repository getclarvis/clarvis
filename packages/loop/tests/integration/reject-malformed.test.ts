import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import type { LLMProvider } from "@clarvis/capability";
import type { MCPClientFactory } from "@clarvis/mcp-client";
import { mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const happy = {
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

async function expectRejectedWithoutEffects(body: unknown, code: string): Promise<void> {
  const llmCall = vi.fn();
  const llm: LLMProvider = {
    async call(params) {
      llmCall(params);
      return {
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
      };
    },
  };
  const mcpFactoryCall = vi.fn();
  const realFactory = mockMCPFactory({});
  const mcp: MCPClientFactory = (tool) => {
    mcpFactoryCall(tool);
    return realFactory(tool);
  };

  harness = await makeHarness({ llm, mcpFactory: mcp });
  await expect(harness.run(body)).rejects.toMatchObject({ code });
  expect(llmCall).not.toHaveBeenCalled();
  expect(mcpFactoryCall).not.toHaveBeenCalled();
}

describe("validation facade — representative end-to-end failures", () => {
  // The exhaustive matrices live in tests/unit/request-*. The integration
  // facade keeps one structural, semantic and nested transport failure, and
  // proves that every class rejects before opening MCP or calling the model.
  it.each([
    {
      label: "structural messages_empty",
      body: { ...happy, messages: [] },
      code: "messages_empty",
    },
    {
      label: "semantic unknown_profile",
      body: {
        ...happy,
        profiles: [
          { name: "a", model: "anthropic/a", tools: [], iteration_limit: 5 },
          { name: "b", model: "anthropic/b", tools: [], iteration_limit: 5 },
        ],
      },
      code: "unknown_profile",
    },
    {
      label: "nested invalid_server_config",
      body: { ...happy, servers: [{ name: "x", transport: "http" }] },
      code: "invalid_server_config",
    },
  ])("$label rejects with zero LLM/MCP work", async ({ body, code }) => {
    await expectRejectedWithoutEffects(body, code);
  });
});
