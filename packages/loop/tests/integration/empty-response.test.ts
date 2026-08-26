import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const soloBody = (messages: unknown[]) => ({
  messages,
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1000, timeout_ms: 30000 },
});

describe("empty_response", () => {
  it("two consecutive empty completions -> status:error, code:empty_response", async () => {
    const llm = new MockLLM({
      script: [
        { usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 0 } },
        { usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 0 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(soloBody([{ role: "user", content: "hi" }]));

    const body = res as unknown as { status: string; error: { code: string } };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("empty_response");
    expect(llm.calls).toHaveLength(2);
  });

  it("a Lead's two consecutive empties end the run with the Lead-specific empty-response message", async () => {
    const llm = new MockLLM({
      script: [
        { usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 0 } },
        { usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 0 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 5,
          can_spawn: ["w"],
        },
        { name: "w", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 1000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; error: { code: string; message: string } };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("empty_response");
    expect(body.error.message).toContain("consecutive completions");
  });

  it("a single empty completion is nudged and retried; the run completes", async () => {
    const llm = new MockLLM({
      script: [
        { usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 0 } },
        { text: "recovered" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(soloBody([{ role: "user", content: "hi" }]));

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("recovered");
    const nudged = llm.calls[1]!.messages.map((m) => JSON.stringify(m.content)).join("\n");
    expect(nudged).toContain("the previous completion was empty");
  });

  it("a reasoning-only completion is not terminal; nudged and retried", async () => {
    const llm = new MockLLM({
      script: [
        {
          reasoning: "let me think about this...",
          reasoningParts: [{ text: "provider continuation state" }],
          usage: { output_tokens: 40 },
        },
        { text: "the answer" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(soloBody([{ role: "user", content: "hi" }]));

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("the answer");
    const nudged = llm.calls[1]!.messages.map((m) => JSON.stringify(m.content)).join("\n");
    expect(nudged).toContain("only internal reasoning");
    const priorAssistant = llm.calls[1]!.messages.find(
      (message) => message.role === "assistant" && "reasoning" in message,
    );
    expect(priorAssistant).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: [{ text: "provider continuation state" }],
    });
  });

  it("the empty streak resets on a non-empty completion", async () => {
    const llm = new MockLLM({
      script: [
        { usage: { output_tokens: 0 } },
        { text: "thinking out loud" },
        { usage: { output_tokens: 0 } },
        { toolCalls: [{ name: "submit_result", arguments: { answer: "done" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      ...soloBody([{ role: "user", content: "hi" }]),
      output_schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });

    const body = res as unknown as { status: string; result: { answer: string } };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ answer: "done" });
    expect(llm.calls).toHaveLength(4);
  });
});
