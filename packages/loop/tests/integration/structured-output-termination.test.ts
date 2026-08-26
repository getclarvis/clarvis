import { describe, it, expect, afterEach } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
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

describe("clean termination & structural anti-give-up", () => {
  it("text without submit_result does NOT complete; appends a runtime note and continues", async () => {
    const llm = new MockLLM({
      script: [
        { text: "I think I'm done — the plaintiff is Jane." },
        { toolCalls: [{ name: "submit_result", arguments: { plaintiff_name: "Jane" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: SCHEMA,
    });

    const body = res as unknown as { status: string; result: { plaintiff_name: string } };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ plaintiff_name: "Jane" });
    expect(llm.calls).toHaveLength(2);
    const turn2 = llm.calls[1]!.messages.map((m) => contentToText(m.content)).join("\n");
    expect(turn2).toContain("[runtime: result not yet submitted; call submit_result to finalize]");
  });
});
