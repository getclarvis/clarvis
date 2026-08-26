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

describe("invalid submission corrected within budget, never silently accepted", () => {
  it("an invalid submit_result does not terminate; a later valid call completes", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "submit_result", arguments: { age: 42 } }] },
        { toolCalls: [{ name: "submit_result", arguments: { plaintiff_name: "Jane" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: SCHEMA,
    });

    const body = res as unknown as { status: string; result: { plaintiff_name: string } };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ plaintiff_name: "Jane" });
    expect(llm.calls).toHaveLength(2);
  });

  it("repeated invalid submissions exhaust budget; the partial is the last raw args, not claimed conformant", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "submit_result", arguments: { age: 1 } }] },
        { toolCalls: [{ name: "submit_result", arguments: { age: 2 } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 2 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: SCHEMA,
    });

    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("budget_exhausted");
    expect(body.result).toEqual({ age: 2 });
  });
});
