import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { plaintiff_name: { type: "string" } },
  required: ["plaintiff_name"],
};

const hasSubmit = (call: { tools: { wireName: string }[] }): boolean =>
  call.tools.some((t) => t.wireName === "submit_result");

describe("Lead+Subagent: only the Lead receives submit_result", () => {
  it("the Lead finalizes a structured result; a spawned Subagent never sees submit_result", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "spawn_subagent", arguments: { title: "w", task: "find the plaintiff name" } },
          ],
        },
        { text: "The plaintiff is Jane." },
        { toolCalls: [{ name: "submit_result", arguments: { plaintiff_name: "Jane" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "Extract the plaintiff name." }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 5,
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 3 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 200000 },
      output_schema: SCHEMA,
    });

    const body = res as unknown as { status: string; result: { plaintiff_name: string } };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ plaintiff_name: "Jane" });

    expect(llm.calls).toHaveLength(3);
    expect(hasSubmit(llm.calls[0]!)).toBe(true);
    expect(hasSubmit(llm.calls[1]!)).toBe(false);
    expect(hasSubmit(llm.calls[2]!)).toBe(true);
    expect(llm.calls[1]!.tools.some((t) => t.wireName === "spawn_subagent")).toBe(false);
  });
});
