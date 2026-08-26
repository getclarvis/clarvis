import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const hasSubmit = (call: { tools: { wireName: string }[] }): boolean =>
  call.tools.some((t) => t.wireName === "submit_result");

describe("no output_schema → byte-identical free-text behavior (additive guarantee)", () => {
  it("subagent-only: text with no tool calls completes on the text; submit_result never advertised", async () => {
    const llm = new MockLLM({ script: [{ text: "The plaintiff is Jane." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("The plaintiff is Jane.");
    expect(typeof body.result).toBe("string");
    expect(hasSubmit(llm.calls[0]!)).toBe(false);
  });

  it("lead+subagent: no submit_result on any agent when output_schema is absent", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "look" } }] },
        { text: "subagent found Jane" },
        { text: "Final answer: Jane." },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          iteration_limit: 5,
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 3 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 200000 },
    });

    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final answer: Jane.");
    expect(llm.calls.every((c) => !hasSubmit(c))).toBe(true);
  });
});
