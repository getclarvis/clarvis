import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "../integration/_fixtures.ts";
import { makeHarness, type TestHarness } from "../integration/_helpers.ts";
import { createAjv } from "../../src/validation/index.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    plaintiff_name: { type: "string" },
    age: { type: ["integer", "null"] },
  },
  required: ["plaintiff_name"],
};

describe("structured result contract", () => {
  it("a completed structured result validates against the output_schema", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "submit_result", arguments: { plaintiff_name: "Jane", age: null } }],
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "Extract." }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: OUTPUT_SCHEMA,
    });

    const body = res as { status: string; result: unknown };
    expect(body.status).toBe("completed");

    const ajv = createAjv();

    const validateSchema = ajv.compile(OUTPUT_SCHEMA);

    const ok = validateSchema(body.result) as boolean;

    expect(ok, ajv.errorsText(validateSchema.errors)).toBe(true);
  });
});
