import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("ModelConfig.max_output_tokens threading", () => {
  it("reaches the provider call params from providers[].models[modelId]", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      providers: [
        {
          name: "anthropic",
          kind: "anthropic" as const,
          models: {
            "claude-sonnet-4-5": { context_window_tokens: 200000, max_output_tokens: 12345 },
          },
        },
      ],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 3 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.maxOutputTokens).toBe(12345);
  });

  it("is absent from the call params when the model config does not set it", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 3 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(res.status).toBe("completed");
    expect(llm.calls[0]!.maxOutputTokens).toBeUndefined();
  });

  it("never lets a reasoning-effort output floor push maxOutputTokens past the context window", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "x".repeat(40_000) }],
      servers: [],
      providers: [
        {
          name: "anthropic",
          kind: "anthropic" as const,
          models: { "claude-opus-4-8": { context_window_tokens: 50_000 } },
        },
      ],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-opus-4-8",
          tools: [],
          iteration_limit: 3,
          reasoning_effort: "max",
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(res.status).toBe("completed");
    // window 50_000, prompt ~10_000 tokens ((40_000 chars / 4) + a few), so
    // available = floor((50_000 - ~10_000) * 0.9) = ~36_000 — well below the
    // "max" reasoning floor (32_768 + 8_192 = 40_960). The window must win.
    expect(llm.calls[0]!.maxOutputTokens).toBeLessThanOrEqual(36_000);
    expect(llm.calls[0]!.maxOutputTokens).toBeGreaterThan(0);
  });

  it("still raises maxOutputTokens toward the reasoning floor when the window has room", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      providers: [
        {
          name: "anthropic",
          kind: "anthropic" as const,
          models: {
            "claude-opus-4-8": { context_window_tokens: 200_000, max_output_tokens: 1_000 },
          },
        },
      ],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-opus-4-8",
          tools: [],
          iteration_limit: 3,
          reasoning_effort: "high",
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(res.status).toBe("completed");
    // configured max_output_tokens (1_000) is well below the "high" floor
    // (8_192 + 8_192 = 16_384), and the window is nearly empty, so the floor
    // should win over the small configured value.
    expect(llm.calls[0]!.maxOutputTokens).toBe(16_384);
  });
});
