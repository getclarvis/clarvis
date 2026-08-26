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
  properties: {
    plaintiff_name: { type: "string" },
    age: { type: ["integer", "null"] },
    tax_id: { type: ["string", "null"] },
  },
  required: ["plaintiff_name"],
};

describe("express partial failure structurally (nullable fields)", () => {
  it("completes with found fields populated and unfound nullable fields as null", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "submit_result", arguments: { plaintiff_name: "Jane", age: 42, tax_id: null } },
          ],
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "Extract details." }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: SCHEMA,
    });

    const body = res as unknown as {
      status: string;
      result: { plaintiff_name: string; age: number; tax_id: null };
    };
    expect(body.status).toBe("completed");
    expect(body.result.plaintiff_name).toBe("Jane");
    expect(body.result.age).toBe(42);
    expect(body.result.tax_id).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(body.result, "tax_id")).toBe(true);
  });
});
