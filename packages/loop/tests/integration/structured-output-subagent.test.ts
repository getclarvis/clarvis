import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

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
    tax_id: { type: ["string", "null"] },
  },
  required: ["plaintiff_name"],
};

describe("structured output (subagent-only): schema-valid object result", () => {
  it("returns status:completed with a structured object result (not a string)", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "submit_result",
              arguments: { plaintiff_name: "Jane Doe", age: 42, tax_id: "TAX-0001" },
            },
          ],
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "Extract the plaintiff details." }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: OUTPUT_SCHEMA,
    });

    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({
      plaintiff_name: "Jane Doe",
      age: 42,
      tax_id: "TAX-0001",
    });
    expect(typeof body.result).toBe("object");
  });

  it("a valid submit_result alongside another tool call takes precedence (sibling not dispatched)", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "submit_result", arguments: { plaintiff_name: "Ada" } },
            { name: "filesystem.read", arguments: { path: "/x" } },
          ],
        },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({
        filesystem: { tools: [{ name: "read", call: () => "should-not-be-called" }] },
      }),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: OUTPUT_SCHEMA,
    });

    const body = res as unknown as { status: string; result: { plaintiff_name: string } };
    expect(body.status).toBe("completed");
    expect(body.result.plaintiff_name).toBe("Ada");
    expect(llm.calls).toHaveLength(1);
  });
});
